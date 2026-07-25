import { DurableObject } from 'cloudflare:workers';

import {
  authorizeSessionRecord,
  bootstrapSessionRecord,
  isSessionRecord,
  sessionAlarmDecision,
  type AuthorizeSessionInput,
  type BootstrapSessionInput,
  type SessionRecord,
} from './security/session-record.js';
import {
  acquireResolvePermit,
  nextResolvePermitDeadline,
  releaseResolvePermit,
  RESOLVE_WINDOW_MS,
  ResolveRateLimitError,
  type ResolveRateLimitState,
} from './security/rate-limit.js';

const sessionTableSql = `CREATE TABLE IF NOT EXISTS session_record (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL,
  session_hash TEXT NOT NULL,
  csrf_hash TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
)`;
const resolveEventsTableSql = `CREATE TABLE IF NOT EXISTS resolve_events (
  event_at INTEGER NOT NULL
)`;
const resolvePermitsTableSql = `CREATE TABLE IF NOT EXISTS resolve_permits (
  permit_id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
)`;

interface AcquirePermitInput extends AuthorizeSessionInput {
  readonly now: number;
  readonly permitId: string;
}

interface ReleasePermitInput {
  readonly sessionHash: string;
  readonly permitId: string;
  readonly now: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
  );
}

export function decodeBootstrapSessionRequest(value: unknown): BootstrapSessionInput | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ['csrfHash', 'expiresAt', 'issuedAt', 'sessionHash'])
  ) {
    return null;
  }
  return typeof value['sessionHash'] === 'string' &&
    typeof value['csrfHash'] === 'string' &&
    typeof value['issuedAt'] === 'number' &&
    typeof value['expiresAt'] === 'number'
    ? {
        sessionHash: value['sessionHash'],
        csrfHash: value['csrfHash'],
        issuedAt: value['issuedAt'],
        expiresAt: value['expiresAt'],
      }
    : null;
}

export function decodeAuthorizeSessionRequest(
  value: unknown,
): (AuthorizeSessionInput & { readonly now: number }) | null {
  if (!isPlainObject(value) || !hasExactKeys(value, ['csrfHash', 'now', 'sessionHash'])) {
    return null;
  }
  return typeof value['sessionHash'] === 'string' &&
    typeof value['csrfHash'] === 'string' &&
    typeof value['now'] === 'number'
    ? { sessionHash: value['sessionHash'], csrfHash: value['csrfHash'], now: value['now'] }
    : null;
}

export function decodeAcquireResolvePermitRequest(value: unknown): AcquirePermitInput | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ['csrfHash', 'now', 'permitId', 'sessionHash'])
  ) {
    return null;
  }
  return typeof value['sessionHash'] === 'string' &&
    typeof value['csrfHash'] === 'string' &&
    typeof value['permitId'] === 'string' &&
    typeof value['now'] === 'number'
    ? {
        sessionHash: value['sessionHash'],
        csrfHash: value['csrfHash'],
        permitId: value['permitId'],
        now: value['now'],
      }
    : null;
}

export function decodeReleaseResolvePermitRequest(value: unknown): ReleasePermitInput | null {
  if (!isPlainObject(value) || !hasExactKeys(value, ['now', 'permitId', 'sessionHash'])) {
    return null;
  }
  return typeof value['sessionHash'] === 'string' &&
    typeof value['permitId'] === 'string' &&
    typeof value['now'] === 'number'
    ? { sessionHash: value['sessionHash'], permitId: value['permitId'], now: value['now'] }
    : null;
}

function safeJson(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status });
}

export class SessionCoordinator extends DurableObject {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.initializeTables();
  }

  private initializeTables(): void {
    this.ctx.storage.sql.exec(sessionTableSql);
    this.ctx.storage.sql.exec(resolveEventsTableSql);
    this.ctx.storage.sql.exec(resolvePermitsTableSql);
  }

  private readRecord(): SessionRecord | null {
    const row = this.ctx.storage.sql
      .exec(
        'SELECT schema_version, session_hash, csrf_hash, issued_at, expires_at FROM session_record WHERE singleton = 1',
      )
      .toArray()[0];
    if (row === undefined) {
      return null;
    }
    const candidate: unknown = {
      schemaVersion: row['schema_version'],
      sessionHash: row['session_hash'],
      csrfHash: row['csrf_hash'],
      issuedAt: row['issued_at'],
      expiresAt: row['expires_at'],
    };
    if (!isSessionRecord(candidate)) {
      throw new Error('Stored session record is invalid.');
    }
    return candidate;
  }

  private writeRecord(record: SessionRecord): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO session_record
        (singleton, schema_version, session_hash, csrf_hash, issued_at, expires_at)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
        schema_version = excluded.schema_version,
        session_hash = excluded.session_hash,
        csrf_hash = excluded.csrf_hash,
        issued_at = excluded.issued_at,
        expires_at = excluded.expires_at`,
      record.schemaVersion,
      record.sessionHash,
      record.csrfHash,
      record.issuedAt,
      record.expiresAt,
    );
  }

  private pruneResolveStorage(now: number): void {
    this.ctx.storage.sql.exec(
      'DELETE FROM resolve_events WHERE event_at <= ?',
      now - RESOLVE_WINDOW_MS,
    );
    this.ctx.storage.sql.exec('DELETE FROM resolve_permits WHERE expires_at <= ?', now);
  }

  private readResolveState(): ResolveRateLimitState {
    const events = this.ctx.storage.sql
      .exec<{ event_at: number }>('SELECT event_at FROM resolve_events ORDER BY event_at')
      .toArray()
      .map((row) => row['event_at']);
    const permits = this.ctx.storage.sql
      .exec<{ permit_id: string; expires_at: number }>(
        'SELECT permit_id, expires_at FROM resolve_permits ORDER BY expires_at',
      )
      .toArray()
      .map((row) => ({ id: row['permit_id'], expiresAt: row['expires_at'] }));
    return { events, permits };
  }

  private async scheduleAlarm(record: SessionRecord): Promise<void> {
    const permitDeadline = nextResolvePermitDeadline(this.readResolveState());
    await this.ctx.storage.setAlarm(
      permitDeadline === null ? record.expiresAt : Math.min(record.expiresAt, permitDeadline),
    );
  }

  private async bootstrap(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return safeJson(400, { ok: false });
    }
    const input = decodeBootstrapSessionRequest(body);
    if (input === null) {
      return safeJson(400, { ok: false });
    }
    const result = this.ctx.storage.transactionSync(() => {
      const transition = bootstrapSessionRecord(this.readRecord(), input, Date.now());
      if (transition.allowed) {
        this.writeRecord(transition.record);
      }
      return transition;
    });
    if (!result.allowed) {
      return safeJson(401, { ok: false });
    }
    await this.scheduleAlarm(result.record);
    return safeJson(200, { ok: true, expiresAt: result.record.expiresAt });
  }

  private async authorize(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return safeJson(400, { ok: false });
    }
    const input = decodeAuthorizeSessionRequest(body);
    if (input === null) {
      return safeJson(400, { ok: false });
    }
    return authorizeSessionRecord(this.readRecord(), input, input.now)
      ? safeJson(200, { ok: true })
      : safeJson(401, { ok: false });
  }

  private async acquirePermit(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return safeJson(400, { ok: false });
    }
    const input = decodeAcquireResolvePermitRequest(body);
    if (input === null) {
      return safeJson(400, { ok: false });
    }
    const result = this.ctx.storage.transactionSync(() => {
      const record = this.readRecord();
      if (!authorizeSessionRecord(record, input, input.now) || record === null) {
        return { status: 401 } as const;
      }
      this.pruneResolveStorage(input.now);
      try {
        const next = acquireResolvePermit(this.readResolveState(), input.now, input.permitId);
        const permit = next.permits.find((candidate) => candidate.id === input.permitId)!;
        this.ctx.storage.sql.exec('INSERT INTO resolve_events (event_at) VALUES (?)', input.now);
        this.ctx.storage.sql.exec(
          'INSERT INTO resolve_permits (permit_id, expires_at) VALUES (?, ?)',
          permit.id,
          permit.expiresAt,
        );
        return { status: 201, record, expiresAt: permit.expiresAt } as const;
      } catch (error: unknown) {
        if (error instanceof ResolveRateLimitError) {
          return { status: error.code === 'RESOLVE_RATE_INVALID' ? 400 : 429 } as const;
        }
        throw error;
      }
    });
    if (result.status !== 201) {
      return safeJson(result.status, { ok: false });
    }
    await this.scheduleAlarm(result.record);
    return safeJson(201, { ok: true, expiresAt: result.expiresAt });
  }

  private async releasePermit(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return safeJson(400, { ok: false });
    }
    const input = decodeReleaseResolvePermitRequest(body);
    if (input === null) {
      return safeJson(400, { ok: false });
    }
    const result = this.ctx.storage.transactionSync(() => {
      const record = this.readRecord();
      if (
        record === null ||
        record.sessionHash !== input.sessionHash ||
        !Number.isSafeInteger(input.now) ||
        input.now < 0 ||
        input.now >= record.expiresAt
      ) {
        return { status: 401 } as const;
      }
      this.pruneResolveStorage(input.now);
      try {
        releaseResolvePermit(this.readResolveState(), input.now, input.permitId);
      } catch (error: unknown) {
        if (error instanceof ResolveRateLimitError) {
          return { status: 400 } as const;
        }
        throw error;
      }
      this.ctx.storage.sql.exec('DELETE FROM resolve_permits WHERE permit_id = ?', input.permitId);
      return { status: 200, record } as const;
    });
    if (result.status !== 200) {
      return safeJson(result.status, { ok: false });
    }
    await this.scheduleAlarm(result.record);
    return safeJson(200, { ok: true });
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return safeJson(404, { ok: false });
    }
    const pathname = new URL(request.url).pathname;
    if (pathname === '/bootstrap') {
      return this.bootstrap(request);
    }
    if (pathname === '/authorize') {
      return this.authorize(request);
    }
    if (pathname === '/resolve-permits/acquire') {
      return this.acquirePermit(request);
    }
    if (pathname === '/resolve-permits/release') {
      return this.releasePermit(request);
    }
    return safeJson(404, { ok: false });
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    const decision = sessionAlarmDecision(this.readRecord(), now);
    if (decision.action === 'delete') {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      this.initializeTables();
      return;
    }
    this.pruneResolveStorage(now);
    await this.scheduleAlarm(this.readRecord()!);
  }
}

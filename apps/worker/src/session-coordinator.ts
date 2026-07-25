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

const tableSql = `CREATE TABLE IF NOT EXISTS session_record (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL,
  session_hash TEXT NOT NULL,
  csrf_hash TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
)`;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
  );
}

function decodeBootstrap(value: unknown): BootstrapSessionInput | null {
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

function decodeAuthorize(
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

function safeJson(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status });
}

export class SessionCoordinator extends DurableObject {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(tableSql);
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

  private async bootstrap(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return safeJson(400, { ok: false });
    }
    const input = decodeBootstrap(body);
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
    await this.ctx.storage.setAlarm(result.record.expiresAt);
    return safeJson(200, { ok: true, expiresAt: result.record.expiresAt });
  }

  private async authorize(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return safeJson(400, { ok: false });
    }
    const input = decodeAuthorize(body);
    if (input === null) {
      return safeJson(400, { ok: false });
    }
    return authorizeSessionRecord(this.readRecord(), input, input.now)
      ? safeJson(200, { ok: true })
      : safeJson(401, { ok: false });
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
    return safeJson(404, { ok: false });
  }

  override async alarm(): Promise<void> {
    const decision = sessionAlarmDecision(this.readRecord(), Date.now());
    if (decision.action === 'delete') {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      this.ctx.storage.sql.exec(tableSql);
      return;
    }
    await this.ctx.storage.setAlarm(decision.expiresAt);
  }
}

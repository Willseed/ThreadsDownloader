import { DurableObject } from 'cloudflare:workers';
import { decodeExactRecord } from '@threads-downloader/contracts/strict-json';

import {
  acquireRateLimitPermit,
  IP_RESOLVE_POLICY,
  nextRateLimitDeadline,
  releaseRateLimitPermit,
  ResolveRateLimitError,
  type RateLimitState,
} from './security/rate-limit.js';
import {
  decideSessionIssuance,
  isSessionIssuanceReservationId,
  SESSION_ISSUANCE_CAPACITY_WINDOW_MS,
  SESSION_ISSUANCE_RESERVATION_MS,
} from './security/session-issuance-rate-limit.js';
import { decodeBase64Url, encodeBase64Url } from './utils/base64url.js';

const schemaVersion = 1;
const metaTableSql = `CREATE TABLE IF NOT EXISTS ip_rate_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL,
  ip_hash TEXT NOT NULL
)`;
const eventsTableSql = `CREATE TABLE IF NOT EXISTS ip_resolve_events (
  event_at INTEGER NOT NULL
)`;
const permitsTableSql = `CREATE TABLE IF NOT EXISTS ip_resolve_permits (
  permit_id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
)`;
const sessionIssuanceTableSql = `CREATE TABLE IF NOT EXISTS ip_session_issuance (
  reservation_id TEXT PRIMARY KEY,
  event_at INTEGER NOT NULL,
  reservation_expires_at INTEGER,
  CHECK (reservation_expires_at IS NULL OR reservation_expires_at > event_at)
)`;
const sessionIssuanceEventIndexSql = `CREATE INDEX IF NOT EXISTS ip_session_issuance_event
  ON ip_session_issuance (event_at)`;
const sessionIssuanceReservationIndexSql = `CREATE INDEX IF NOT EXISTS ip_session_issuance_reservation
  ON ip_session_issuance (reservation_expires_at)`;

interface IpPermitRequest {
  readonly ipHash: string;
  readonly permitId: string;
  readonly now: number;
}

interface SessionIssuanceRequest {
  readonly ipHash: string;
  readonly reservationId: string;
  readonly now: number;
}

function isIpHash(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 43) {
    return false;
  }
  try {
    const decoded = decodeBase64Url(value);
    return decoded.byteLength === 32 && encodeBase64Url(decoded) === value;
  } catch {
    return false;
  }
}

function isPermitId(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    return decodeBase64Url(value).byteLength >= 16;
  } catch {
    return false;
  }
}

function isSafeTime(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <=
      Number.MAX_SAFE_INTEGER -
        Math.max(
          IP_RESOLVE_POLICY.windowMs,
          IP_RESOLVE_POLICY.leaseMs,
          SESSION_ISSUANCE_CAPACITY_WINDOW_MS,
          SESSION_ISSUANCE_RESERVATION_MS,
        )
  );
}

export function decodeIpRateLimitRequest(value: unknown): IpPermitRequest | null {
  const record = decodeExactRecord(value, ['ipHash', 'now', 'permitId']);
  if (
    record === null ||
    !isIpHash(record['ipHash']) ||
    !isPermitId(record['permitId']) ||
    !isSafeTime(record['now'])
  ) {
    return null;
  }
  return { ipHash: record['ipHash'], permitId: record['permitId'], now: record['now'] };
}

export function decodeSessionIssuanceRequest(value: unknown): SessionIssuanceRequest | null {
  const record = decodeExactRecord(value, ['ipHash', 'now', 'reservationId']);
  if (
    record === null ||
    !isIpHash(record['ipHash']) ||
    !isSessionIssuanceReservationId(record['reservationId']) ||
    !isSafeTime(record['now'])
  ) {
    return null;
  }
  return {
    ipHash: record['ipHash'],
    reservationId: record['reservationId'],
    now: record['now'],
  };
}

export class IpRateLimiter extends DurableObject {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.initializeTables();
  }

  private initializeTables(): void {
    this.ctx.storage.sql.exec(metaTableSql);
    this.ctx.storage.sql.exec(eventsTableSql);
    this.ctx.storage.sql.exec(permitsTableSql);
    this.ctx.storage.sql.exec(sessionIssuanceTableSql);
    this.ctx.storage.sql.exec(sessionIssuanceEventIndexSql);
    this.ctx.storage.sql.exec(sessionIssuanceReservationIndexSql);
  }

  private readIpHash(): string | null {
    const row = this.ctx.storage.sql
      .exec<{ schema_version: number; ip_hash: string }>(
        'SELECT schema_version, ip_hash FROM ip_rate_meta WHERE singleton = 1',
      )
      .toArray()[0];
    if (row === undefined) {
      return null;
    }
    if (row['schema_version'] !== schemaVersion || row['ip_hash'].length !== 43) {
      throw new Error('Stored IP rate metadata is invalid.');
    }
    return row['ip_hash'];
  }

  private ensureIpHash(ipHash: string): boolean {
    const stored = this.readIpHash();
    if (stored !== null) {
      return stored === ipHash;
    }
    this.ctx.storage.sql.exec(
      'INSERT INTO ip_rate_meta (singleton, schema_version, ip_hash) VALUES (1, ?, ?)',
      schemaVersion,
      ipHash,
    );
    return true;
  }

  private matchesIpHash(ipHash: string): boolean {
    const stored = this.readIpHash();
    return stored === null || stored === ipHash;
  }

  private prune(now: number): void {
    this.ctx.storage.sql.exec(
      'DELETE FROM ip_resolve_events WHERE event_at <= ?',
      now - IP_RESOLVE_POLICY.windowMs,
    );
    this.ctx.storage.sql.exec('DELETE FROM ip_resolve_permits WHERE expires_at <= ?', now);
    this.ctx.storage.sql.exec(
      `UPDATE ip_session_issuance
       SET reservation_expires_at = NULL
       WHERE reservation_expires_at <= ?`,
      now,
    );
    this.ctx.storage.sql.exec(
      'DELETE FROM ip_session_issuance WHERE event_at <= ?',
      now - SESSION_ISSUANCE_CAPACITY_WINDOW_MS,
    );
  }

  private readState(): RateLimitState {
    const events = this.ctx.storage.sql
      .exec<{ event_at: number }>('SELECT event_at FROM ip_resolve_events ORDER BY event_at')
      .toArray()
      .map((row) => row['event_at']);
    const permits = this.ctx.storage.sql
      .exec<{ permit_id: string; expires_at: number }>(
        'SELECT permit_id, expires_at FROM ip_resolve_permits ORDER BY expires_at',
      )
      .toArray()
      .map((row) => ({ id: row['permit_id'], expiresAt: row['expires_at'] }));
    return { events, permits };
  }

  private readSessionIssuanceEvents(): readonly number[] {
    return this.ctx.storage.sql
      .exec<{ event_at: number }>(
        'SELECT event_at FROM ip_session_issuance ORDER BY event_at, reservation_id',
      )
      .toArray()
      .map((row) => row['event_at']);
  }

  private readSessionIssuanceDeadline(): number | null {
    const row = this.ctx.storage.sql
      .exec<{ event_at: number | null; reservation_expires_at: number | null }>(
        `SELECT MIN(event_at) AS event_at,
                MIN(reservation_expires_at) AS reservation_expires_at
         FROM ip_session_issuance`,
      )
      .toArray()[0];
    const eventAt = row?.['event_at'];
    const reservationExpiresAt = row?.['reservation_expires_at'];
    const deadlines: number[] = [];
    if (typeof eventAt === 'number') {
      deadlines.push(eventAt + SESSION_ISSUANCE_CAPACITY_WINDOW_MS);
    }
    if (typeof reservationExpiresAt === 'number') {
      deadlines.push(reservationExpiresAt);
    }
    return deadlines.length === 0 ? null : Math.min(...deadlines);
  }

  private async scheduleAlarm(): Promise<void> {
    const deadlines = [
      nextRateLimitDeadline(this.readState(), IP_RESOLVE_POLICY),
      this.readSessionIssuanceDeadline(),
    ].filter((value): value is number => value !== null);
    if (deadlines.length !== 0) {
      await this.ctx.storage.setAlarm(Math.min(...deadlines));
      return;
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.initializeTables();
  }

  private async acquire(input: IpPermitRequest): Promise<Response> {
    const result = this.ctx.storage.transactionSync(() => {
      if (!this.ensureIpHash(input.ipHash)) {
        return { status: 400 } as const;
      }
      this.prune(input.now);
      try {
        const state = acquireRateLimitPermit(
          this.readState(),
          input.now,
          input.permitId,
          IP_RESOLVE_POLICY,
        );
        const permit = state.permits.find((candidate) => candidate.id === input.permitId)!;
        this.ctx.storage.sql.exec('INSERT INTO ip_resolve_events (event_at) VALUES (?)', input.now);
        this.ctx.storage.sql.exec(
          'INSERT INTO ip_resolve_permits (permit_id, expires_at) VALUES (?, ?)',
          permit.id,
          permit.expiresAt,
        );
        return { status: 201, expiresAt: permit.expiresAt } as const;
      } catch (error: unknown) {
        if (error instanceof ResolveRateLimitError) {
          return { status: error.code === 'RESOLVE_RATE_INVALID' ? 400 : 429 } as const;
        }
        throw error;
      }
    });
    if (result.status !== 201) {
      return Response.json({ ok: false }, { status: result.status });
    }
    await this.scheduleAlarm();
    return Response.json({ ok: true, expiresAt: result.expiresAt }, { status: 201 });
  }

  private async release(input: IpPermitRequest): Promise<Response> {
    const status = this.ctx.storage.transactionSync(() => {
      if (!this.matchesIpHash(input.ipHash)) {
        return 400;
      }
      this.prune(input.now);
      try {
        releaseRateLimitPermit(this.readState(), input.now, input.permitId, IP_RESOLVE_POLICY);
      } catch (error: unknown) {
        if (error instanceof ResolveRateLimitError) {
          return 400;
        }
        throw error;
      }
      this.ctx.storage.sql.exec(
        'DELETE FROM ip_resolve_permits WHERE permit_id = ?',
        input.permitId,
      );
      return 200;
    });
    if (status !== 200) {
      return Response.json({ ok: false }, { status });
    }
    await this.scheduleAlarm();
    return Response.json({ ok: true });
  }

  private async reserveSessionIssuance(input: SessionIssuanceRequest): Promise<Response> {
    const result = this.ctx.storage.transactionSync(() => {
      if (!this.ensureIpHash(input.ipHash)) {
        return { status: 400 } as const;
      }
      this.prune(input.now);
      const existing = this.ctx.storage.sql
        .exec<{ reservation_expires_at: number | null }>(
          `SELECT reservation_expires_at
           FROM ip_session_issuance
           WHERE reservation_id = ?`,
          input.reservationId,
        )
        .toArray()[0];
      if (existing !== undefined) {
        return existing['reservation_expires_at'] === null
          ? ({ status: 409 } as const)
          : ({ status: 201, expiresAt: existing['reservation_expires_at'] } as const);
      }

      const decision = decideSessionIssuance(this.readSessionIssuanceEvents(), input.now);
      if (!decision.allowed) {
        return { status: 429, retryAt: decision.retryAt } as const;
      }
      const expiresAt = input.now + SESSION_ISSUANCE_RESERVATION_MS;
      this.ctx.storage.sql.exec(
        `INSERT INTO ip_session_issuance
          (reservation_id, event_at, reservation_expires_at)
         VALUES (?, ?, ?)`,
        input.reservationId,
        input.now,
        expiresAt,
      );
      return { status: 201, expiresAt } as const;
    });
    if (result.status === 429) {
      await this.scheduleAlarm();
      return Response.json({ ok: false, retryAt: result.retryAt }, { status: 429 });
    }
    if (result.status !== 201) {
      return Response.json({ ok: false }, { status: result.status });
    }
    await this.scheduleAlarm();
    return Response.json(
      { ok: true, reservationId: input.reservationId, expiresAt: result.expiresAt },
      { status: 201 },
    );
  }

  private async commitSessionIssuance(input: SessionIssuanceRequest): Promise<Response> {
    const status = this.ctx.storage.transactionSync(() => {
      if (!this.matchesIpHash(input.ipHash)) {
        return 400;
      }
      this.prune(input.now);
      const existing = this.ctx.storage.sql
        .exec<{ reservation_expires_at: number | null }>(
          `SELECT reservation_expires_at
           FROM ip_session_issuance
           WHERE reservation_id = ?`,
          input.reservationId,
        )
        .toArray()[0];
      if (existing === undefined) {
        return 409;
      }
      if (existing['reservation_expires_at'] !== null) {
        this.ctx.storage.sql.exec(
          `UPDATE ip_session_issuance
           SET reservation_expires_at = NULL
           WHERE reservation_id = ?`,
          input.reservationId,
        );
      }
      return 200;
    });
    if (status !== 200) {
      return Response.json({ ok: false }, { status });
    }
    await this.scheduleAlarm();
    return Response.json({ ok: true });
  }

  private async releaseSessionIssuance(input: SessionIssuanceRequest): Promise<Response> {
    const status = this.ctx.storage.transactionSync(() => {
      if (!this.matchesIpHash(input.ipHash)) {
        return 400;
      }
      this.prune(input.now);
      const existing = this.ctx.storage.sql
        .exec<{ reservation_expires_at: number | null }>(
          `SELECT reservation_expires_at
           FROM ip_session_issuance
           WHERE reservation_id = ?`,
          input.reservationId,
        )
        .toArray()[0];
      if (existing === undefined) {
        return 200;
      }
      if (existing['reservation_expires_at'] === null) {
        return 409;
      }
      this.ctx.storage.sql.exec(
        'DELETE FROM ip_session_issuance WHERE reservation_id = ?',
        input.reservationId,
      );
      return 200;
    });
    if (status !== 200) {
      return Response.json({ ok: false }, { status });
    }
    await this.scheduleAlarm();
    return Response.json({ ok: true });
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return Response.json({ ok: false }, { status: 404 });
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ ok: false }, { status: 400 });
    }
    const pathname = new URL(request.url).pathname;
    if (pathname.startsWith('/session-issuance/')) {
      const input = decodeSessionIssuanceRequest(body);
      if (input === null) {
        return Response.json({ ok: false }, { status: 400 });
      }
      if (pathname === '/session-issuance/reserve') {
        return this.reserveSessionIssuance(input);
      }
      if (pathname === '/session-issuance/commit') {
        return this.commitSessionIssuance(input);
      }
      if (pathname === '/session-issuance/release') {
        return this.releaseSessionIssuance(input);
      }
      return Response.json({ ok: false }, { status: 404 });
    }
    const input = decodeIpRateLimitRequest(body);
    if (input === null) {
      return Response.json({ ok: false }, { status: 400 });
    }
    if (pathname === '/acquire') {
      return this.acquire(input);
    }
    if (pathname === '/release') {
      return this.release(input);
    }
    return Response.json({ ok: false }, { status: 404 });
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    this.prune(now);
    await this.scheduleAlarm();
  }
}

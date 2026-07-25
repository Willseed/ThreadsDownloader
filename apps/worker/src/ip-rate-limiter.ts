import { DurableObject } from 'cloudflare:workers';

import {
  acquireRateLimitPermit,
  IP_RESOLVE_POLICY,
  nextRateLimitDeadline,
  releaseRateLimitPermit,
  ResolveRateLimitError,
  type RateLimitState,
} from './security/rate-limit.js';
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

interface IpPermitRequest {
  readonly ipHash: string;
  readonly permitId: string;
  readonly now: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
      Number.MAX_SAFE_INTEGER - Math.max(IP_RESOLVE_POLICY.windowMs, IP_RESOLVE_POLICY.leaseMs)
  );
}

export function decodeIpRateLimitRequest(value: unknown): IpPermitRequest | null {
  if (!isPlainObject(value) || Object.keys(value).sort().join(',') !== 'ipHash,now,permitId') {
    return null;
  }
  return isIpHash(value['ipHash']) && isPermitId(value['permitId']) && isSafeTime(value['now'])
    ? { ipHash: value['ipHash'], permitId: value['permitId'], now: value['now'] }
    : null;
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

  private async scheduleAlarm(): Promise<void> {
    const deadline = nextRateLimitDeadline(this.readState(), IP_RESOLVE_POLICY);
    if (deadline !== null) {
      await this.ctx.storage.setAlarm(deadline);
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
    const input = decodeIpRateLimitRequest(body);
    if (input === null) {
      return Response.json({ ok: false }, { status: 400 });
    }
    const pathname = new URL(request.url).pathname;
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

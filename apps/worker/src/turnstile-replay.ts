import { DurableObject } from 'cloudflare:workers';
import { decodeExactRecord } from '@threads-downloader/contracts/strict-json';

const replayLifetimeMs = 300_000;
const tableSql = `CREATE TABLE IF NOT EXISTS turnstile_replay (
  token_hash TEXT PRIMARY KEY,
  consumed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
)`;

interface ReplayReservation {
  readonly tokenHash: string;
  readonly consumedAt: number;
  readonly expiresAt: number;
}

function isCanonicalHash(value: string): boolean {
  return value.length === 43 && /^[A-Za-z0-9_-]+$/u.test(value);
}

function decodeReservation(value: unknown): ReplayReservation | null {
  const record = decodeExactRecord(value, ['consumedAt', 'expiresAt', 'tokenHash']);
  if (
    record === null ||
    typeof record['tokenHash'] !== 'string' ||
    !isCanonicalHash(record['tokenHash']) ||
    typeof record['consumedAt'] !== 'number' ||
    !Number.isSafeInteger(record['consumedAt']) ||
    record['consumedAt'] < 0 ||
    typeof record['expiresAt'] !== 'number' ||
    !Number.isSafeInteger(record['expiresAt']) ||
    record['expiresAt'] <= record['consumedAt'] ||
    record['expiresAt'] - record['consumedAt'] > replayLifetimeMs
  ) {
    return null;
  }
  return {
    tokenHash: record['tokenHash'],
    consumedAt: record['consumedAt'],
    expiresAt: record['expiresAt'],
  };
}

export class TurnstileReplay extends DurableObject {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(tableSql);
  }

  private reserve(input: ReplayReservation): boolean {
    return this.ctx.storage.transactionSync(() => {
      const existing = this.ctx.storage.sql
        .exec<{ expires_at: number }>(
          'SELECT expires_at FROM turnstile_replay WHERE token_hash = ?',
          input.tokenHash,
        )
        .toArray()[0];
      if (existing !== undefined && existing['expires_at'] > input.consumedAt) {
        return false;
      }
      this.ctx.storage.sql.exec('DELETE FROM turnstile_replay');
      this.ctx.storage.sql.exec(
        'INSERT INTO turnstile_replay (token_hash, consumed_at, expires_at) VALUES (?, ?, ?)',
        input.tokenHash,
        input.consumedAt,
        input.expiresAt,
      );
      return true;
    });
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/reserve') {
      return Response.json({ ok: false }, { status: 404 });
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ ok: false }, { status: 400 });
    }
    const input = decodeReservation(body);
    if (input === null || input.expiresAt <= Date.now()) {
      return Response.json({ ok: false }, { status: 400 });
    }
    if (!this.reserve(input)) {
      return Response.json({ ok: false }, { status: 409 });
    }
    await this.ctx.storage.setAlarm(input.expiresAt);
    return Response.json({ ok: true }, { status: 201 });
  }

  override async alarm(): Promise<void> {
    const row = this.ctx.storage.sql
      .exec<{ expires_at: number }>('SELECT expires_at FROM turnstile_replay LIMIT 1')
      .toArray()[0];
    if (row !== undefined && row['expires_at'] > Date.now()) {
      await this.ctx.storage.setAlarm(row['expires_at']);
      return;
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.ctx.storage.sql.exec(tableSql);
  }
}

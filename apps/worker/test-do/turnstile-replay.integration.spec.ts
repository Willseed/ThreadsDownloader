import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { hashIdentifier } from '../src/security/cryptography.js';
import type { TurnstileReplay } from '../src/turnstile-replay.js';

interface TestEnv {
  readonly TURNSTILE_REPLAYS: DurableObjectNamespace<TurnstileReplay>;
}

interface StoredReplayRow {
  readonly [key: string]: string | number | ArrayBuffer | null;
  readonly token_hash: string;
  readonly consumed_at: number;
  readonly expires_at: number;
}

const testEnv = env as unknown as TestEnv;

function replayStub(tokenHash: string): DurableObjectStub<TurnstileReplay> {
  return testEnv.TURNSTILE_REPLAYS.get(testEnv.TURNSTILE_REPLAYS.idFromName(tokenHash));
}

function reserve(
  stub: DurableObjectStub<TurnstileReplay>,
  tokenHash: string,
  consumedAt: number,
): Promise<Response> {
  return stub.fetch('https://turnstile-replay.internal/reserve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tokenHash, consumedAt, expiresAt: consumedAt + 300_000 }),
  });
}

describe('TurnstileReplay in workerd', () => {
  it('atomically accepts the first concurrent reservation and rejects the second', async () => {
    const tokenHash = await hashIdentifier('concurrent-raw-token');
    const stub = replayStub(tokenHash);
    const consumedAt = Date.now();
    const responses = await Promise.all([
      reserve(stub, tokenHash, consumedAt),
      reserve(stub, tokenHash, consumedAt),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
  });

  it('stores only the hash and timestamps', async () => {
    const rawToken = 'raw-token-must-not-persist';
    const tokenHash = await hashIdentifier(rawToken);
    const consumedAt = Date.now();
    const stub = replayStub(tokenHash);
    expect((await reserve(stub, tokenHash, consumedAt)).status).toBe(201);

    const rows = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<StoredReplayRow>('SELECT token_hash, consumed_at, expires_at FROM turnstile_replay')
        .toArray(),
    );
    expect(rows).toEqual([
      { token_hash: tokenHash, consumed_at: consumedAt, expires_at: consumedAt + 300_000 },
    ]);
    expect(JSON.stringify(rows)).not.toContain(rawToken);
  });

  it('cleans expired state and safely permits reuse', async () => {
    const tokenHash = await hashIdentifier('reusable-token');
    const stub = replayStub(tokenHash);
    const first = Date.now();
    expect((await reserve(stub, tokenHash, first)).status).toBe(201);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec('UPDATE turnstile_replay SET expires_at = ?', Date.now() - 1);
    });
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);

    const rows = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<StoredReplayRow>('SELECT * FROM turnstile_replay').toArray(),
    );
    expect(rows).toEqual([]);
    expect((await reserve(stub, tokenHash, Date.now())).status).toBe(201);
    expect((await stub.fetch('https://turnstile-replay.internal/missing')).status).toBe(404);
  });
});

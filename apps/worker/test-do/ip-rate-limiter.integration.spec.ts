import {
  abortAllDurableObjects,
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { IpRateLimiter } from '../src/ip-rate-limiter.js';
import { createOpaqueId, hashIdentifier } from '../src/security/cryptography.js';
import { IP_RESOLVE_PERMIT_LEASE_MS } from '../src/security/rate-limit.js';
import {
  MAX_SESSION_ISSUANCE_BURST,
  MAX_SESSION_ISSUANCE_CAPACITY,
  SESSION_ISSUANCE_CAPACITY_WINDOW_MS,
} from '../src/security/session-issuance-rate-limit.js';

interface TestEnv {
  readonly IP_RATE_LIMITS: DurableObjectNamespace<IpRateLimiter>;
}

interface MetaRow {
  readonly [key: string]: string | number | ArrayBuffer | null;
  readonly ip_hash: string;
  readonly schema_version: number;
}

const testEnv = env as unknown as TestEnv;

function limiterStub(ipHash: string): DurableObjectStub<IpRateLimiter> {
  return testEnv.IP_RATE_LIMITS.get(testEnv.IP_RATE_LIMITS.idFromName(ipHash));
}

async function acquire(
  stub: DurableObjectStub<IpRateLimiter>,
  ipHash: string,
  permitId: string,
  now: number,
): Promise<Response> {
  return stub.fetch('https://ip-rate-limit.internal/acquire', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ipHash, permitId, now }),
  });
}

async function release(
  stub: DurableObjectStub<IpRateLimiter>,
  ipHash: string,
  permitId: string,
  now: number,
): Promise<Response> {
  return stub.fetch('https://ip-rate-limit.internal/release', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ipHash, permitId, now }),
  });
}

async function mutateSessionIssuance(
  stub: DurableObjectStub<IpRateLimiter>,
  operation: 'commit' | 'release' | 'reserve',
  ipHash: string,
  reservationId: string,
  now: number,
): Promise<Response> {
  return stub.fetch(`https://ip-rate-limit.internal/session-issuance/${operation}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ipHash, reservationId, now }),
  });
}

async function uniqueHash(label: string): Promise<string> {
  return hashIdentifier(`${label}:${crypto.randomUUID()}`);
}

describe('IpRateLimiter in workerd', () => {
  it('admits three concurrent leases and admits again after idempotent release', async () => {
    const ipHash = await uniqueHash('concurrency');
    const stub = limiterStub(ipHash);
    const now = Date.now();
    const permitIds = Array.from({ length: 4 }, () => createOpaqueId());

    for (let index = 0; index < 3; index += 1) {
      expect((await acquire(stub, ipHash, permitIds[index]!, now + index)).status).toBe(201);
    }
    expect((await acquire(stub, ipHash, permitIds[3]!, now + 3)).status).toBe(429);
    expect((await release(stub, ipHash, permitIds[0]!, now + 4)).status).toBe(200);
    expect((await release(stub, ipHash, permitIds[0]!, now + 5)).status).toBe(200);
    expect((await acquire(stub, ipHash, permitIds[3]!, now + 6)).status).toBe(201);
  });

  it('denies the twenty-first admitted attempt in a sixty-second window', async () => {
    const ipHash = await uniqueHash('window');
    const stub = limiterStub(ipHash);
    const now = Date.now();

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const permitId = createOpaqueId();
      expect((await acquire(stub, ipHash, permitId, now + attempt * 2)).status).toBe(201);
      expect((await release(stub, ipHash, permitId, now + attempt * 2 + 1)).status).toBe(200);
    }
    expect((await acquire(stub, ipHash, createOpaqueId(), now + 50)).status).toBe(429);
  });

  it('persists only the keyed hash, opaque permits, and timestamps', async () => {
    const rawIp = '203.0.113.199';
    const ipHash = await uniqueHash('storage');
    const permitId = createOpaqueId();
    const reservationId = createOpaqueId();
    const stub = limiterStub(ipHash);
    const now = Date.now();
    expect((await acquire(stub, ipHash, permitId, now)).status).toBe(201);
    expect((await mutateSessionIssuance(stub, 'reserve', ipHash, reservationId, now)).status).toBe(
      201,
    );

    const stored = await runInDurableObject(stub, (_instance, state) => ({
      meta: state.storage.sql
        .exec<MetaRow>('SELECT schema_version, ip_hash FROM ip_rate_meta')
        .toArray(),
      events: state.storage.sql.exec('SELECT event_at FROM ip_resolve_events').toArray(),
      permits: state.storage.sql
        .exec('SELECT permit_id, expires_at FROM ip_resolve_permits')
        .toArray(),
      issuance: state.storage.sql
        .exec('SELECT reservation_id, event_at, reservation_expires_at FROM ip_session_issuance')
        .toArray(),
    }));
    expect(stored.meta).toEqual([{ schema_version: 1, ip_hash: ipHash }]);
    expect(stored.events).toHaveLength(1);
    expect(stored.permits).toEqual([
      { permit_id: permitId, expires_at: now + IP_RESOLVE_PERMIT_LEASE_MS },
    ]);
    expect(stored.issuance).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(rawIp);
  });

  it('adds the issuance table to pre-issuance storage without altering resolve state', async () => {
    const ipHash = await uniqueHash('issuance-table-upgrade');
    const stub = limiterStub(ipHash);
    const permitId = createOpaqueId();
    const now = Date.now();
    expect((await acquire(stub, ipHash, permitId, now)).status).toBe(201);

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec('DROP TABLE ip_session_issuance');
    });
    await abortAllDurableObjects();

    const restartedStub = limiterStub(ipHash);
    const reservationId = createOpaqueId();
    expect(
      (await mutateSessionIssuance(restartedStub, 'reserve', ipHash, reservationId, now + 1))
        .status,
    ).toBe(201);
    const stored = await runInDurableObject(restartedStub, (_instance, state) => ({
      meta: state.storage.sql
        .exec<MetaRow>('SELECT schema_version, ip_hash FROM ip_rate_meta')
        .toArray(),
      events: state.storage.sql.exec('SELECT event_at FROM ip_resolve_events').toArray(),
      permits: state.storage.sql
        .exec('SELECT permit_id, expires_at FROM ip_resolve_permits')
        .toArray(),
      issuance: state.storage.sql.exec('SELECT reservation_id FROM ip_session_issuance').toArray(),
    }));
    expect(stored.meta).toEqual([{ schema_version: 1, ip_hash: ipHash }]);
    expect(stored.events).toEqual([{ event_at: now }]);
    expect(stored.permits).toEqual([
      expect.objectContaining({
        permit_id: permitId,
      }),
    ]);
    expect(stored.issuance).toEqual([{ reservation_id: reservationId }]);
  });

  it('rejects a hash that does not match the pinned object identity', async () => {
    const ipHash = await uniqueHash('pinned');
    const otherHash = await uniqueHash('other');
    const stub = limiterStub(ipHash);
    const now = Date.now();
    expect((await acquire(stub, ipHash, createOpaqueId(), now)).status).toBe(201);
    expect((await acquire(stub, otherHash, createOpaqueId(), now + 1)).status).toBe(400);
  });

  it('atomically admits only sixty parallel session issuance reservations', async () => {
    const ipHash = await uniqueHash('session-parallel');
    const stub = limiterStub(ipHash);
    const now = Date.now();
    const responses = await Promise.all(
      Array.from({ length: MAX_SESSION_ISSUANCE_BURST + 1 }, () =>
        mutateSessionIssuance(stub, 'reserve', ipHash, createOpaqueId(), now),
      ),
    );
    expect(responses.filter((response) => response.status === 201)).toHaveLength(
      MAX_SESSION_ISSUANCE_BURST,
    );
    expect(responses.filter((response) => response.status === 429)).toHaveLength(1);
  });

  it('enforces the 512-event capacity after allowing the final available slot', async () => {
    const ipHash = await uniqueHash('session-capacity');
    const stub = limiterStub(ipHash);
    const now = Date.now();
    const seed = createOpaqueId();
    expect((await mutateSessionIssuance(stub, 'reserve', ipHash, seed, now)).status).toBe(201);
    expect((await mutateSessionIssuance(stub, 'commit', ipHash, seed, now)).status).toBe(200);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec('DELETE FROM ip_session_issuance');
      for (let index = 0; index < MAX_SESSION_ISSUANCE_CAPACITY - 1; index += 1) {
        state.storage.sql.exec(
          `INSERT INTO ip_session_issuance
            (reservation_id, event_at, reservation_expires_at)
           VALUES (?, ?, NULL)`,
          createOpaqueId(),
          now - 40_000_000 + index * 70_000,
        );
      }
    });

    const finalReservation = createOpaqueId();
    expect(
      (await mutateSessionIssuance(stub, 'reserve', ipHash, finalReservation, now)).status,
    ).toBe(201);
    expect(
      (await mutateSessionIssuance(stub, 'reserve', ipHash, createOpaqueId(), now)).status,
    ).toBe(429);
  });

  it('commits, releases, and conservatively retains an expired reservation', async () => {
    const ipHash = await uniqueHash('session-lifecycle');
    const stub = limiterStub(ipHash);
    const now = Date.now();
    const releasedId = createOpaqueId();
    expect((await mutateSessionIssuance(stub, 'reserve', ipHash, releasedId, now)).status).toBe(
      201,
    );
    expect((await mutateSessionIssuance(stub, 'release', ipHash, releasedId, now)).status).toBe(
      200,
    );

    const committedId = createOpaqueId();
    expect(
      (await mutateSessionIssuance(stub, 'reserve', ipHash, committedId, now + 1)).status,
    ).toBe(201);
    expect((await mutateSessionIssuance(stub, 'commit', ipHash, committedId, now + 1)).status).toBe(
      200,
    );
    expect(
      (await mutateSessionIssuance(stub, 'release', ipHash, committedId, now + 1)).status,
    ).toBe(409);

    const expiredId = createOpaqueId();
    expect((await mutateSessionIssuance(stub, 'reserve', ipHash, expiredId, now + 2)).status).toBe(
      201,
    );
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE ip_session_issuance SET reservation_expires_at = ? WHERE reservation_id = ?',
        Date.now() - 1,
        expiredId,
      );
    });
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
    const retained = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ reservation_expires_at: number | null }>(
          'SELECT reservation_expires_at FROM ip_session_issuance WHERE reservation_id = ?',
          expiredId,
        )
        .toArray(),
    );
    expect(retained).toEqual([{ reservation_expires_at: null }]);
  });

  it('cleans expired leases and window events by alarm, then safely reuses the object', async () => {
    const ipHash = await uniqueHash('alarm');
    const stub = limiterStub(ipHash);
    const now = Date.now();
    expect((await acquire(stub, ipHash, createOpaqueId(), now)).status).toBe(201);

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec('UPDATE ip_resolve_events SET event_at = ?', Date.now() - 60_001);
      state.storage.sql.exec('UPDATE ip_resolve_permits SET expires_at = ?', Date.now() - 1);
      state.storage.sql.exec(
        'INSERT INTO ip_session_issuance (reservation_id, event_at, reservation_expires_at) VALUES (?, ?, NULL)',
        createOpaqueId(),
        Date.now() - SESSION_ISSUANCE_CAPACITY_WINDOW_MS - 1,
      );
    });
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
    const rows = await runInDurableObject(stub, (_instance, state) => ({
      meta: state.storage.sql.exec('SELECT ip_hash FROM ip_rate_meta').toArray(),
      events: state.storage.sql.exec('SELECT event_at FROM ip_resolve_events').toArray(),
      permits: state.storage.sql.exec('SELECT permit_id FROM ip_resolve_permits').toArray(),
      issuance: state.storage.sql.exec('SELECT reservation_id FROM ip_session_issuance').toArray(),
    }));
    expect(rows).toEqual({ meta: [], events: [], permits: [], issuance: [] });
    expect((await acquire(stub, ipHash, createOpaqueId(), Date.now())).status).toBe(201);
  });
});

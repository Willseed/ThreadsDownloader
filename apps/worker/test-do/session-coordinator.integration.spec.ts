import { SELF, env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { createOpaqueId, hashIdentifier } from '../src/security/cryptography.js';
import type { SessionCoordinator } from '../src/session-coordinator.js';

interface TestEnv {
  readonly SESSIONS: DurableObjectNamespace<SessionCoordinator>;
}

interface SessionBody {
  readonly csrfToken: string;
  readonly expiresAt: string;
}

interface StoredRow {
  readonly [key: string]: string | number | ArrayBuffer | null;
  readonly schema_version: number;
  readonly session_hash: string;
  readonly csrf_hash: string;
  readonly issued_at: number;
  readonly expires_at: number;
}

const testEnv = env as unknown as TestEnv;

function sessionStub(rawId: string): DurableObjectStub<SessionCoordinator> {
  return testEnv.SESSIONS.get(testEnv.SESSIONS.idFromName(rawId));
}

function cookieValue(response: Response): string {
  return response.headers.get('set-cookie')!.split(';', 1)[0]!.split('=', 2)[1]!;
}

async function readRows(stub: DurableObjectStub<SessionCoordinator>): Promise<StoredRow[]> {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<StoredRow>(
        'SELECT schema_version, session_hash, csrf_hash, issued_at, expires_at FROM session_record',
      )
      .toArray(),
  );
}

async function bootstrap(
  stub: DurableObjectStub<SessionCoordinator>,
  input: {
    readonly sessionHash: string;
    readonly csrfHash: string;
    readonly issuedAt: number;
    readonly expiresAt: number;
  },
): Promise<Response> {
  return stub.fetch('https://session.internal/bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

async function authorize(
  stub: DurableObjectStub<SessionCoordinator>,
  sessionHash: string,
  csrfHash: string,
  now: number,
): Promise<Response> {
  return stub.fetch('https://session.internal/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionHash, csrfHash, now }),
  });
}

async function acquirePermit(
  stub: DurableObjectStub<SessionCoordinator>,
  sessionHash: string,
  csrfHash: string,
  permitId: string,
  now: number,
): Promise<Response> {
  return stub.fetch('https://session.internal/resolve-permits/acquire', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionHash, csrfHash, permitId, now }),
  });
}

async function releasePermit(
  stub: DurableObjectStub<SessionCoordinator>,
  sessionHash: string,
  permitId: string,
  now: number,
): Promise<Response> {
  return stub.fetch('https://session.internal/resolve-permits/release', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionHash, permitId, now }),
  });
}

describe('SessionCoordinator in workerd', () => {
  it('creates, resumes, and replaces browser sessions through SELF', async () => {
    const first = await SELF.fetch('https://session.test/api/session');
    const firstBody = (await first.json()) as SessionBody;
    const signedCookie = cookieValue(first);
    const rawId = signedCookie.split('.', 1)[0]!;

    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-store');
    expect(first.headers.get('set-cookie')).toContain('Path=/');
    expect(first.headers.get('set-cookie')).toContain('Max-Age=43200');
    expect(first.headers.get('set-cookie')).toContain('HttpOnly');
    expect(first.headers.get('set-cookie')).toContain('Secure');
    expect(first.headers.get('set-cookie')).toContain('SameSite=Lax');
    expect(first.headers.get('set-cookie')).not.toContain('Domain');
    expect(firstBody.csrfToken).toHaveLength(43);
    expect(Date.parse(firstBody.expiresAt)).toBeGreaterThan(Date.now());
    expect(JSON.stringify(firstBody)).not.toContain(rawId);

    const resumed = await SELF.fetch('https://session.test/api/session', {
      headers: { cookie: `__Host-td_session=${signedCookie}` },
    });
    const resumedBody = (await resumed.json()) as SessionBody;
    expect(resumed.status).toBe(200);
    expect(resumed.headers.get('set-cookie')).toBeNull();
    expect(resumedBody.csrfToken).not.toBe(firstBody.csrfToken);
    expect(resumedBody.expiresAt).toBe(firstBody.expiresAt);
    expect(await readRows(sessionStub(rawId))).toHaveLength(1);

    const changedLast = signedCookie.endsWith('A') ? 'B' : 'A';
    const tampered = `${signedCookie.slice(0, -1)}${changedLast}`;
    const replaced = await SELF.fetch('https://session.test/api/session', {
      headers: { cookie: `__Host-td_session=${tampered}` },
    });
    expect(replaced.status).toBe(200);
    expect(cookieValue(replaced)).not.toBe(signedCookie);
  });

  it('stores only hashes and timestamps in one SQLite row', async () => {
    const rawId = 'raw-session-id-not-for-storage';
    const csrfToken = 'raw-csrf-token-not-for-storage';
    const sessionHash = await hashIdentifier(rawId);
    const csrfHash = await hashIdentifier(csrfToken);
    const issuedAt = Date.now();
    const expiresAt = issuedAt + 60_000;
    const stub = sessionStub(rawId);

    expect(await bootstrap(stub, { sessionHash, csrfHash, issuedAt, expiresAt })).toHaveProperty(
      'status',
      200,
    );
    const rows = await readRows(stub);
    expect(rows).toEqual([
      {
        schema_version: 1,
        session_hash: sessionHash,
        csrf_hash: csrfHash,
        issued_at: issuedAt,
        expires_at: expiresAt,
      },
    ]);
    const stored = JSON.stringify(rows);
    expect(stored).not.toContain(rawId);
    expect(stored).not.toContain(csrfToken);
  });

  it('authorizes exact hashes, preserves expiry, and survives a new stub handle', async () => {
    const rawId = 'restartable-object';
    const sessionHash = await hashIdentifier(rawId);
    const csrfHash = await hashIdentifier('csrf-one');
    const rotatedHash = await hashIdentifier('csrf-two');
    const issuedAt = Date.now();
    const expiresAt = issuedAt + 60_000;
    const stub = sessionStub(rawId);

    expect(await bootstrap(stub, { sessionHash, csrfHash, issuedAt, expiresAt })).toHaveProperty(
      'status',
      200,
    );
    expect((await authorize(stub, sessionHash, csrfHash, issuedAt)).status).toBe(200);
    expect((await authorize(stub, sessionHash, rotatedHash, issuedAt)).status).toBe(401);
    expect((await authorize(stub, rotatedHash, csrfHash, issuedAt)).status).toBe(401);

    const later = issuedAt + 1_000;
    const bootstrapAgain = await bootstrap(stub, {
      sessionHash,
      csrfHash: rotatedHash,
      issuedAt: later,
      expiresAt: expiresAt + 60_000,
    });
    await expect(bootstrapAgain.json()).resolves.toEqual({ ok: true, expiresAt });
    const newHandle = sessionStub(rawId);
    expect((await authorize(newHandle, sessionHash, rotatedHash, later)).status).toBe(200);
    expect((await readRows(newHandle))[0]?.expires_at).toBe(expiresAt);
  });

  it('schedules and executes expiry cleanup safely', async () => {
    const rawId = 'expiring-object';
    const sessionHash = await hashIdentifier(rawId);
    const csrfHash = await hashIdentifier('expiring-csrf');
    const now = Date.now();
    const stub = sessionStub(rawId);
    await bootstrap(stub, { sessionHash, csrfHash, issuedAt: now, expiresAt: now + 60_000 });

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec('UPDATE session_record SET expires_at = ?', Date.now() - 1);
    });
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
    await expect(authorize(stub, sessionHash, csrfHash, Date.now())).resolves.toHaveProperty(
      'status',
      401,
    );
  });

  it('enforces one concurrent permit and admits after idempotent release', async () => {
    const rawId = 'concurrent-resolve-session';
    const sessionHash = await hashIdentifier(rawId);
    const csrfHash = await hashIdentifier('concurrent-csrf');
    const now = Date.now();
    const stub = sessionStub(rawId);
    await bootstrap(stub, { sessionHash, csrfHash, issuedAt: now, expiresAt: now + 120_000 });
    const firstId = createOpaqueId();
    const secondId = createOpaqueId();

    expect((await acquirePermit(stub, sessionHash, csrfHash, firstId, now)).status).toBe(201);
    expect((await acquirePermit(stub, sessionHash, csrfHash, secondId, now + 1)).status).toBe(429);
    expect((await releasePermit(stub, sessionHash, firstId, now + 2)).status).toBe(200);
    expect((await releasePermit(stub, sessionHash, firstId, now + 3)).status).toBe(200);
    expect((await acquirePermit(stub, sessionHash, csrfHash, secondId, now + 4)).status).toBe(201);
  });

  it('denies the sixth admitted resolve within the sliding window', async () => {
    const rawId = 'windowed-resolve-session';
    const sessionHash = await hashIdentifier(rawId);
    const csrfHash = await hashIdentifier('windowed-csrf');
    const now = Date.now();
    const stub = sessionStub(rawId);
    await bootstrap(stub, { sessionHash, csrfHash, issuedAt: now, expiresAt: now + 120_000 });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const permitId = createOpaqueId();
      expect(
        (await acquirePermit(stub, sessionHash, csrfHash, permitId, now + attempt * 2)).status,
      ).toBe(201);
      expect((await releasePermit(stub, sessionHash, permitId, now + attempt * 2 + 1)).status).toBe(
        200,
      );
    }
    expect(
      (await acquirePermit(stub, sessionHash, csrfHash, createOpaqueId(), now + 20)).status,
    ).toBe(429);
  });

  it('persists only opaque permit state and cleans an expired lease by alarm', async () => {
    const rawId = 'raw-session-never-in-rate-tables';
    const rawCsrf = 'raw-csrf-never-in-rate-tables';
    const sessionHash = await hashIdentifier(rawId);
    const csrfHash = await hashIdentifier(rawCsrf);
    const now = Date.now();
    const stub = sessionStub(rawId);
    await bootstrap(stub, { sessionHash, csrfHash, issuedAt: now, expiresAt: now + 120_000 });
    const permitId = createOpaqueId();
    expect((await acquirePermit(stub, sessionHash, csrfHash, permitId, now)).status).toBe(201);

    const stored = await runInDurableObject(stub, (_instance, state) => ({
      events: state.storage.sql.exec('SELECT event_at FROM resolve_events').toArray(),
      permits: state.storage.sql
        .exec('SELECT permit_id, expires_at FROM resolve_permits')
        .toArray(),
    }));
    expect(stored.events).toHaveLength(1);
    expect(stored.permits).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(rawId);
    expect(JSON.stringify(stored)).not.toContain(rawCsrf);
    expect(JSON.stringify(stored)).not.toContain(sessionHash);
    expect(JSON.stringify(stored)).not.toContain(csrfHash);

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec('UPDATE resolve_permits SET expires_at = ?', Date.now() - 1);
    });
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
    const permits = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec('SELECT permit_id FROM resolve_permits').toArray(),
    );
    expect(permits).toEqual([]);
    expect(
      (await acquirePermit(stub, sessionHash, csrfHash, createOpaqueId(), now + 1)).status,
    ).toBe(201);
  });
});

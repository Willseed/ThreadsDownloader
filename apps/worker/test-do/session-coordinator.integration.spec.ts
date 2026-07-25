import { SELF, env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { ProbedMedia } from '../src/resolver/media-probe.js';
import { createOpaqueId, hashIdentifier } from '../src/security/cryptography.js';
import { encodeProbedMediaWire } from '../src/security/resolve-vault.js';
import { parseCdnUrl } from '../src/security/upstream-policy.js';
import { decodeBase64Url } from '../src/utils/base64url.js';
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

interface StoredVaultCandidate {
  readonly candidateId: string;
  readonly filename: string;
  readonly contentLength?: number;
}

interface StoredVaultBatch {
  readonly resolveId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly candidates: readonly StoredVaultCandidate[];
}

interface ClaimedVaultCandidate {
  readonly reservationId: string;
  readonly reservedAt: number;
  readonly reservationExpiresAt: number;
  readonly grant: Record<string, unknown>;
}

interface VaultRow {
  readonly [key: string]: string | number | ArrayBuffer | null;
  readonly resolve_id: string;
  readonly permit_id: string;
  readonly state: string;
  readonly store_token: string | null;
  readonly issued_at: number;
  readonly expires_at: number;
  readonly staging_expires_at: number | null;
  readonly candidate_id: string;
  readonly filename: string;
  readonly content_length: number | null;
  readonly sealed_grant: string | null;
  readonly reservation_id: string | null;
  readonly reservation_expires_at: number | null;
}

const privateMediaUrl =
  'https://video.cdninstagram.com/media/private.mp4?token=must-stay-in-the-vault';

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

function probedMedia(overrides: Partial<ProbedMedia> = {}): ProbedMedia {
  return {
    finalUrl: parseCdnUrl(privateMediaUrl),
    contentType: 'video/mp4',
    contentLength: 1_024,
    rangeCapability: 'bytes',
    strongEtag: '"vault-etag"',
    lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
    validator: { kind: 'etag', value: '"vault-etag"' },
    completionReliable: true,
    probeMethod: 'head',
    ...overrides,
  };
}

async function storeVault(
  stub: DurableObjectStub<SessionCoordinator>,
  input: {
    readonly sessionHash: string;
    readonly csrfHash: string;
    readonly permitId: string;
    readonly now: number;
    readonly shortcode?: string;
    readonly candidates?: readonly ProbedMedia[];
  },
): Promise<Response> {
  return stub.fetch('https://session.internal/resolve-vault/store', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionHash: input.sessionHash,
      csrfHash: input.csrfHash,
      permitId: input.permitId,
      now: input.now,
      shortcode: input.shortcode ?? 'Abcde_1',
      candidates: (input.candidates ?? [probedMedia()]).map(encodeProbedMediaWire),
    }),
  });
}

async function claimVault(
  stub: DurableObjectStub<SessionCoordinator>,
  input: {
    readonly sessionHash: string;
    readonly csrfHash: string;
    readonly now: number;
    readonly resolveId: string;
    readonly candidateId: string;
    readonly reservationId: string;
  },
): Promise<Response> {
  return stub.fetch('https://session.internal/resolve-vault/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

async function settleVault(
  stub: DurableObjectStub<SessionCoordinator>,
  input: {
    readonly sessionHash: string;
    readonly csrfHash: string;
    readonly now: number;
    readonly resolveId: string;
    readonly candidateId: string;
    readonly reservationId: string;
    readonly outcome: 'consume' | 'release';
  },
): Promise<Response> {
  return stub.fetch('https://session.internal/resolve-vault/settle', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

async function readVaultRows(stub: DurableObjectStub<SessionCoordinator>): Promise<VaultRow[]> {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<VaultRow>(
        `SELECT b.resolve_id, b.permit_id, b.state, b.store_token, b.issued_at, b.expires_at,
                b.staging_expires_at,
                c.candidate_id, c.filename, c.content_length, c.sealed_grant,
                c.reservation_id, c.reservation_expires_at
         FROM resolved_media_batches b
         INNER JOIN resolved_media_candidates c ON c.resolve_id = b.resolve_id
         ORDER BY b.issued_at, c.ordinal`,
      )
      .toArray(),
  );
}

async function prepareVaultSession(rawId: string): Promise<{
  readonly stub: DurableObjectStub<SessionCoordinator>;
  readonly sessionHash: string;
  readonly csrfHash: string;
  readonly permitId: string;
  readonly now: number;
}> {
  const stub = sessionStub(rawId);
  const sessionHash = await hashIdentifier(rawId);
  const csrfHash = await hashIdentifier(`${rawId}-csrf`);
  const permitId = createOpaqueId();
  const now = Date.now();
  expect(
    (await bootstrap(stub, { sessionHash, csrfHash, issuedAt: now, expiresAt: now + 600_000 }))
      .status,
  ).toBe(200);
  expect((await acquirePermit(stub, sessionHash, csrfHash, permitId, now)).status).toBe(201);
  return { stub, sessionHash, csrfHash, permitId, now };
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

  it('stores encrypted grants and applies idempotent reservation and settlement transitions', async () => {
    const { stub, sessionHash, csrfHash, permitId, now } =
      await prepareVaultSession('vault-lifecycle-session');
    const storeResponse = await storeVault(stub, {
      sessionHash,
      csrfHash,
      permitId,
      now,
      candidates: [
        probedMedia(),
        probedMedia({
          contentType: 'video/webm',
          contentLength: null,
          completionReliable: false,
        }),
      ],
    });
    expect(storeResponse.status).toBe(201);
    const stored = (await storeResponse.json()) as StoredVaultBatch & { readonly ok: true };

    expect(decodeBase64Url(stored.resolveId)).toHaveLength(24);
    expect(stored.expiresAt).toBeGreaterThan(stored.issuedAt);
    expect(stored.expiresAt - stored.issuedAt).toBeLessThanOrEqual(300_000);
    expect(stored.candidates).toHaveLength(2);
    expect(decodeBase64Url(stored.candidates[0]!.candidateId)).toHaveLength(24);
    expect(stored.candidates).toEqual([
      {
        candidateId: stored.candidates[0]!.candidateId,
        filename: 'threads_Abcde_1_1.mp4',
        contentLength: 1_024,
      },
      {
        candidateId: stored.candidates[1]!.candidateId,
        filename: 'threads_Abcde_1_2.webm',
      },
    ]);
    expect(JSON.stringify(stored)).not.toContain(privateMediaUrl);

    const rows = await readVaultRows(stub);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.state === 'ready')).toBe(true);
    expect(rows.every((row) => row.store_token === null)).toBe(true);
    expect(rows.every((row) => row.staging_expires_at === null)).toBe(true);
    expect(rows.every((row) => row.issued_at === stored.issuedAt)).toBe(true);
    expect(rows.every((row) => row.sealed_grant?.startsWith('v1.'))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(privateMediaUrl);
    expect(JSON.stringify(rows)).not.toContain('must-stay-in-the-vault');

    const candidateId = stored.candidates[0]!.candidateId;
    const firstReservation = createOpaqueId();
    expect(
      (
        await claimVault(stub, {
          sessionHash,
          csrfHash: await hashIdentifier('wrong-vault-csrf'),
          now: now + 1,
          resolveId: stored.resolveId,
          candidateId,
          reservationId: createOpaqueId(),
        })
      ).status,
    ).toBe(401);
    const firstClaim = await claimVault(stub, {
      sessionHash,
      csrfHash,
      now: now + 1,
      resolveId: stored.resolveId,
      candidateId,
      reservationId: firstReservation,
    });
    expect(firstClaim.status).toBe(200);
    const firstClaimBody = (await firstClaim.json()) as ClaimedVaultCandidate;
    expect(firstClaimBody.reservationId).toBe(firstReservation);
    expect(firstClaimBody.reservedAt).toBeGreaterThan(0);
    expect(firstClaimBody.reservationExpiresAt).toBeGreaterThan(firstClaimBody.reservedAt);
    expect(firstClaimBody.reservationExpiresAt - firstClaimBody.reservedAt).toBeLessThanOrEqual(
      30_000,
    );
    expect(firstClaimBody.grant['finalUrl']).toBe(privateMediaUrl);

    expect(
      (
        await claimVault(stub, {
          sessionHash,
          csrfHash,
          now: now + 2,
          resolveId: stored.resolveId,
          candidateId,
          reservationId: firstReservation,
        })
      ).status,
    ).toBe(200);
    const conflictingReservation = createOpaqueId();
    expect(
      (
        await claimVault(stub, {
          sessionHash,
          csrfHash,
          now: now + 3,
          resolveId: stored.resolveId,
          candidateId,
          reservationId: conflictingReservation,
        })
      ).status,
    ).toBe(409);

    const released = {
      sessionHash,
      csrfHash,
      resolveId: stored.resolveId,
      candidateId,
      reservationId: firstReservation,
      outcome: 'release' as const,
    };
    expect(
      (
        await settleVault(stub, {
          ...released,
          csrfHash: await hashIdentifier('wrong-vault-settle-csrf'),
          now: now + 4,
        })
      ).status,
    ).toBe(401);
    expect((await settleVault(stub, { ...released, now: now + 4 })).status).toBe(200);
    expect((await settleVault(stub, { ...released, now: now + 5 })).status).toBe(200);

    const consumingReservation = createOpaqueId();
    expect(
      (
        await claimVault(stub, {
          sessionHash,
          csrfHash,
          now: now + 6,
          resolveId: stored.resolveId,
          candidateId,
          reservationId: consumingReservation,
        })
      ).status,
    ).toBe(200);
    const consumed = {
      sessionHash,
      csrfHash,
      resolveId: stored.resolveId,
      candidateId,
      reservationId: consumingReservation,
      outcome: 'consume' as const,
    };
    expect((await settleVault(stub, { ...consumed, now: now + 7 })).status).toBe(200);
    expect((await settleVault(stub, { ...consumed, now: now + 8 })).status).toBe(200);
    expect(
      (
        await claimVault(stub, {
          sessionHash,
          csrfHash,
          now: now + 9,
          resolveId: stored.resolveId,
          candidateId,
          reservationId: createOpaqueId(),
        })
      ).status,
    ).toBe(404);

    expect(
      (
        await claimVault(sessionStub('vault-lifecycle-session'), {
          sessionHash,
          csrfHash,
          now: now + 10,
          resolveId: stored.resolveId,
          candidateId: stored.candidates[1]!.candidateId,
          reservationId: createOpaqueId(),
        })
      ).status,
    ).toBe(200);
  });

  it('uses the fresh object clock and caps batch expiry at the session or five minutes', async () => {
    const rawId = 'vault-fresh-clock-session';
    const stub = sessionStub(rawId);
    const sessionHash = await hashIdentifier(rawId);
    const csrfHash = await hashIdentifier(`${rawId}-csrf`);
    const now = Date.now();
    const sessionExpiresAt = now + 20_000;
    const permitId = createOpaqueId();
    expect(
      (await bootstrap(stub, { sessionHash, csrfHash, issuedAt: now, expiresAt: sessionExpiresAt }))
        .status,
    ).toBe(200);
    expect((await acquirePermit(stub, sessionHash, csrfHash, permitId, now)).status).toBe(201);
    expect(
      (
        await storeVault(stub, {
          sessionHash,
          csrfHash: await hashIdentifier('wrong-store-csrf'),
          permitId,
          now,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await storeVault(stub, {
          sessionHash,
          csrfHash,
          permitId: createOpaqueId(),
          now,
        })
      ).status,
    ).toBe(409);

    const futureCallerClock = Number.MAX_SAFE_INTEGER - 300_000;
    const response = await storeVault(stub, {
      sessionHash,
      csrfHash,
      permitId,
      now: futureCallerClock,
    });
    expect(response.status).toBe(201);
    const stored = (await response.json()) as StoredVaultBatch;
    expect(stored.expiresAt).toBe(sessionExpiresAt);
    const [row] = await readVaultRows(stub);
    expect(stored.issuedAt).toBe(row!.issued_at);
    expect(row!.expires_at).toBe(sessionExpiresAt);
    expect(row!.issued_at).toBeLessThanOrEqual(Date.now());

    const longSession = await prepareVaultSession('vault-five-minute-session');
    const longResponse = await storeVault(longSession.stub, longSession);
    expect(longResponse.status).toBe(201);
    const [longRow] = await readVaultRows(longSession.stub);
    expect(longRow!.expires_at - longRow!.issued_at).toBe(300_000);
  });

  it('enforces five-batch and fifty-candidate capacity with per-session isolation', async () => {
    const primary = await prepareVaultSession('vault-capacity-session');
    const batches: StoredVaultBatch[] = [];
    const tenCandidates = Array.from({ length: 10 }, (_, index) =>
      probedMedia({ contentLength: 1_024 + index }),
    );
    let permitId = primary.permitId;
    for (let batchIndex = 0; batchIndex < 5; batchIndex += 1) {
      const response = await storeVault(primary.stub, {
        ...primary,
        permitId,
        now: primary.now + batchIndex,
        candidates: tenCandidates,
      });
      expect(response.status).toBe(201);
      batches.push((await response.json()) as StoredVaultBatch);
      if (batchIndex < 4) {
        expect(
          (
            await releasePermit(
              primary.stub,
              primary.sessionHash,
              permitId,
              primary.now + batchIndex,
            )
          ).status,
        ).toBe(200);
        permitId = createOpaqueId();
        expect(
          (
            await acquirePermit(
              primary.stub,
              primary.sessionHash,
              primary.csrfHash,
              permitId,
              primary.now + batchIndex + 1,
            )
          ).status,
        ).toBe(201);
      }
    }
    expect(await readVaultRows(primary.stub)).toHaveLength(50);
    expect(
      (
        await storeVault(primary.stub, {
          ...primary,
          permitId,
          now: primary.now + 5,
        })
      ).status,
    ).toBe(409);
    expect(
      (await releasePermit(primary.stub, primary.sessionHash, permitId, primary.now + 5)).status,
    ).toBe(200);
    const capacityPermit = createOpaqueId();
    await runInDurableObject(primary.stub, (_instance, state) => {
      state.storage.sql.exec(
        'INSERT INTO resolve_permits (permit_id, expires_at) VALUES (?, ?)',
        capacityPermit,
        Date.now() + 30_000,
      );
    });
    expect(
      (
        await storeVault(primary.stub, {
          ...primary,
          permitId: capacityPermit,
          now: primary.now + 5,
        })
      ).status,
    ).toBe(429);

    const other = await prepareVaultSession('vault-isolated-session');
    const first = batches[0]!;
    expect(
      (
        await claimVault(other.stub, {
          sessionHash: other.sessionHash,
          csrfHash: other.csrfHash,
          now: other.now + 1,
          resolveId: first.resolveId,
          candidateId: first.candidates[0]!.candidateId,
          reservationId: createOpaqueId(),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await claimVault(primary.stub, {
          sessionHash: other.sessionHash,
          csrfHash: primary.csrfHash,
          now: primary.now + 6,
          resolveId: first.resolveId,
          candidateId: first.candidates[0]!.candidateId,
          reservationId: createOpaqueId(),
        })
      ).status,
    ).toBe(401);

    await runInDurableObject(primary.stub, (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE resolved_media_batches SET expires_at = ? WHERE resolve_id = ?',
        primary.now - 1,
        first.resolveId,
      );
    });
    expect(
      (
        await storeVault(primary.stub, {
          ...primary,
          permitId: capacityPermit,
          now: primary.now + 7,
        })
      ).status,
    ).toBe(201);
  });

  it('deletes AAD-tampered grants and alarm-prunes reservations, staging, and expiry', async () => {
    const context = await prepareVaultSession('vault-cleanup-session');
    const storedResponse = await storeVault(context.stub, {
      ...context,
      candidates: [probedMedia(), probedMedia({ contentLength: 2_048 })],
    });
    const stored = (await storedResponse.json()) as StoredVaultBatch;
    let rows = await readVaultRows(context.stub);
    expect(rows).toHaveLength(2);
    await runInDurableObject(context.stub, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE resolved_media_candidates SET sealed_grant = ?
         WHERE resolve_id = ? AND candidate_id = ?`,
        rows[1]!.sealed_grant,
        stored.resolveId,
        stored.candidates[0]!.candidateId,
      );
    });
    expect(
      (
        await claimVault(context.stub, {
          sessionHash: context.sessionHash,
          csrfHash: context.csrfHash,
          now: context.now + 1,
          resolveId: stored.resolveId,
          candidateId: stored.candidates[0]!.candidateId,
          reservationId: createOpaqueId(),
        })
      ).status,
    ).toBe(500);
    rows = await readVaultRows(context.stub);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.candidate_id).toBe(stored.candidates[1]!.candidateId);

    const expiredReservation = createOpaqueId();
    expect(
      (
        await claimVault(context.stub, {
          sessionHash: context.sessionHash,
          csrfHash: context.csrfHash,
          now: context.now + 2,
          resolveId: stored.resolveId,
          candidateId: stored.candidates[1]!.candidateId,
          reservationId: expiredReservation,
        })
      ).status,
    ).toBe(200);
    await runInDurableObject(context.stub, (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE resolved_media_candidates SET reservation_expires_at = ?',
        Date.now() - 1,
      );
    });
    expect(
      (
        await settleVault(context.stub, {
          sessionHash: context.sessionHash,
          csrfHash: context.csrfHash,
          now: context.now,
          resolveId: stored.resolveId,
          candidateId: stored.candidates[1]!.candidateId,
          reservationId: expiredReservation,
          outcome: 'consume',
        })
      ).status,
    ).toBe(409);
    expect(await readVaultRows(context.stub)).toHaveLength(1);
    await expect(runDurableObjectAlarm(context.stub)).resolves.toBe(true);
    expect(
      (
        await claimVault(context.stub, {
          sessionHash: context.sessionHash,
          csrfHash: context.csrfHash,
          now: Date.now(),
          resolveId: stored.resolveId,
          candidateId: stored.candidates[1]!.candidateId,
          reservationId: createOpaqueId(),
        })
      ).status,
    ).toBe(200);

    await runInDurableObject(context.stub, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE resolved_media_batches
         SET state = 'staging', store_token = ?, staging_expires_at = ?
         WHERE resolve_id = ?`,
        createOpaqueId(),
        Date.now() - 1,
        stored.resolveId,
      );
    });
    await expect(runDurableObjectAlarm(context.stub)).resolves.toBe(true);
    expect(await readVaultRows(context.stub)).toEqual([]);

    const expiringResponse = await storeVault(context.stub, { ...context, now: Date.now() });
    expect(expiringResponse.status).toBe(201);
    const expiring = (await expiringResponse.json()) as StoredVaultBatch;
    await runInDurableObject(context.stub, (_instance, state) => {
      state.storage.sql.exec('UPDATE resolved_media_batches SET expires_at = ?', Date.now() - 1);
    });
    await expect(runDurableObjectAlarm(context.stub)).resolves.toBe(true);
    expect(
      (
        await claimVault(context.stub, {
          sessionHash: context.sessionHash,
          csrfHash: context.csrfHash,
          now: Date.now(),
          resolveId: expiring.resolveId,
          candidateId: expiring.candidates[0]!.candidateId,
          reservationId: createOpaqueId(),
        })
      ).status,
    ).toBe(404);
  });

  it('compensates staging rows after seal or CAS failure', async () => {
    const cryptoFailure = await prepareVaultSession('vault-crypto-failure-session');
    await runInDurableObject(cryptoFailure.stub, (instance) => {
      Reflect.set(instance, 'grantKey', 'invalid-test-key');
      Reflect.set(instance, 'grantCodecPromise', null);
    });
    expect((await storeVault(cryptoFailure.stub, cryptoFailure)).status).toBe(500);
    expect(await readVaultRows(cryptoFailure.stub)).toEqual([]);

    const releasedPermit = await prepareVaultSession('vault-released-permit-session');
    await runInDurableObject(releasedPermit.stub, (instance, state) => {
      Reflect.set(
        instance,
        'grantCodecPromise',
        Promise.resolve({
          seal: () => {
            state.storage.sql.exec(
              'DELETE FROM resolve_permits WHERE permit_id = ?',
              releasedPermit.permitId,
            );
            return Promise.resolve('v1.test.test');
          },
          open: () => Promise.reject(new Error('unused test open')),
        }),
      );
    });
    expect((await storeVault(releasedPermit.stub, releasedPermit)).status).toBe(500);
    expect(await readVaultRows(releasedPermit.stub)).toEqual([]);

    const casFailure = await prepareVaultSession('vault-cas-failure-session');
    await runInDurableObject(casFailure.stub, (instance) => {
      Reflect.set(instance, 'commitVaultStore', () => false);
    });
    expect((await storeVault(casFailure.stub, casFailure)).status).toBe(500);
    expect(await readVaultRows(casFailure.stub)).toEqual([]);
  });

  it('does not return a grant when reservation ownership changes during decrypt', async () => {
    const context = await prepareVaultSession('vault-decrypt-race-session');
    const storeResponse = await storeVault(context.stub, context);
    const stored = (await storeResponse.json()) as StoredVaultBatch;
    const candidateId = stored.candidates[0]!.candidateId;
    const replacementReservation = createOpaqueId();
    const replacementMedia = probedMedia();
    await runInDurableObject(context.stub, (instance, state) => {
      Reflect.set(
        instance,
        'grantCodecPromise',
        Promise.resolve({
          seal: () => Promise.reject(new Error('unused test seal')),
          open: () => {
            state.storage.sql.exec(
              `UPDATE resolved_media_candidates
               SET reservation_id = ?, reservation_expires_at = ?
               WHERE resolve_id = ? AND candidate_id = ?`,
              replacementReservation,
              Date.now() + 30_000,
              stored.resolveId,
              candidateId,
            );
            return Promise.resolve(replacementMedia);
          },
        }),
      );
    });

    const response = await claimVault(context.stub, {
      sessionHash: context.sessionHash,
      csrfHash: context.csrfHash,
      now: context.now,
      resolveId: stored.resolveId,
      candidateId,
      reservationId: createOpaqueId(),
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ ok: false });
    const [row] = await readVaultRows(context.stub);
    expect(row!.reservation_id).toBe(replacementReservation);
  });
});

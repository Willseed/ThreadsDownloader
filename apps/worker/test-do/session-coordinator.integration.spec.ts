import { SELF, env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { ProbedMedia } from '../src/resolver/media-probe.js';
import { hashClientIp } from '../src/security/client-ip.js';
import {
  createKeyedIdentifierHasher,
  createOpaqueId,
  hashIdentifier,
  importSigningKey,
} from '../src/security/cryptography.js';
import { RESOLVE_VAULT_TTL_MS } from '../src/security/resolve-vault.js';
import type { ResolvedMediaGrantCodec } from '../src/security/resolved-media-grant.js';
import { encodeProbedMediaWire } from '../src/security/resolved-media-wire.js';
import { RESOLVE_PERMIT_LEASE_MS } from '../src/security/rate-limit.js';
import { parseCdnUrl } from '../src/security/upstream-policy.js';
import { decodeBase64Url } from '../src/utils/base64url.js';
import type { IpRateLimiter } from '../src/ip-rate-limiter.js';
import type { SessionCoordinator } from '../src/session-coordinator.js';

interface TestEnv {
  readonly IP_RATE_LIMITS: DurableObjectNamespace<IpRateLimiter>;
  readonly SESSION_SIGNING_KEY: string;
  readonly SESSIONS: DurableObjectNamespace<SessionCoordinator>;
}

type SqlValue = string | number | ArrayBuffer | null;

interface SessionBody {
  readonly csrfToken: string;
  readonly expiresAt: string;
}

interface StoredRow {
  readonly [key: string]: SqlValue;
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

interface SessionDownloadPermitRow {
  readonly [key: string]: SqlValue;
  readonly permit_id: string;
  readonly download_id: string;
  readonly sequence: number;
  readonly acquired_at: number;
  readonly renewed_at: number;
  readonly expires_at: number;
}

interface SessionDownloadPermitMutationCountRow {
  readonly [key: string]: SqlValue;
  readonly count: number;
}

interface SessionDownloadPermitIdRow {
  readonly [key: string]: SqlValue;
  readonly permit_id: string;
}

interface SessionDownloadSnapshot {
  readonly alarmAt: number | null;
  readonly permits: readonly SessionDownloadPermitRow[];
}

type SessionDownloadPermitOperation = 'acquire' | 'release' | 'renew';

interface SessionDownloadPermitRequestInput {
  readonly sessionHash: string;
  readonly downloadId: string;
  readonly permitId: string;
  readonly sequence?: number;
}

interface ClaimedVaultCandidate {
  readonly reservationId: string;
  readonly reservedAt: number;
  readonly reservationExpiresAt: number;
  readonly filename: string;
  readonly shortcode: string;
  readonly grant: Record<string, unknown>;
}

interface VaultRow {
  readonly [key: string]: SqlValue;
  readonly resolve_id: string;
  readonly permit_id: string;
  readonly state: string;
  readonly store_token: string | null;
  readonly issued_at: number;
  readonly expires_at: number;
  readonly staging_expires_at: number | null;
  readonly shortcode: string;
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

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function sessionStub(rawId: string): DurableObjectStub<SessionCoordinator> {
  return testEnv.SESSIONS.get(testEnv.SESSIONS.idFromName(rawId));
}

async function issuanceLimiterStub(ip: string): Promise<DurableObjectStub<IpRateLimiter>> {
  const signingKey = await importSigningKey(testEnv.SESSION_SIGNING_KEY);
  const ipHash = await hashClientIp(
    new Headers({ 'CF-Connecting-IP': ip }),
    createKeyedIdentifierHasher(signingKey),
  );
  return testEnv.IP_RATE_LIMITS.get(testEnv.IP_RATE_LIMITS.idFromName(ipHash));
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
  return stub.fetch('https://session.internal/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

async function resumeCoordinator(
  stub: DurableObjectStub<SessionCoordinator>,
  sessionHash: string,
  csrfHash: string,
): Promise<Response> {
  return stub.fetch('https://session.internal/resume', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionHash, csrfHash }),
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

async function sessionDownloadPermit(
  stub: DurableObjectStub<SessionCoordinator>,
  operation: SessionDownloadPermitOperation,
  input: SessionDownloadPermitRequestInput,
): Promise<Response> {
  return stub.fetch(`https://session.internal/download-permits/${operation}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

function sessionDownloadPermitRequest(
  operation: SessionDownloadPermitOperation,
  input: SessionDownloadPermitRequestInput,
): Request {
  return new Request(`https://session.internal/download-permits/${operation}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

async function withFailNextAlarm<T>(
  instance: SessionCoordinator,
  beforeFailure: () => void | Promise<void>,
  operation: () => Promise<T>,
): Promise<T> {
  const storage = (
    instance as unknown as { readonly ctx: { readonly storage: DurableObjectStorage } }
  ).ctx.storage;
  const previousDescriptor = Object.getOwnPropertyDescriptor(storage, 'setAlarm');
  const setAlarm = storage.setAlarm.bind(storage);
  let intercept = true;
  Object.defineProperty(storage, 'setAlarm', {
    configurable: true,
    async value(...args: Parameters<DurableObjectStorage['setAlarm']>): Promise<void> {
      if (!intercept) {
        await setAlarm(...args);
        return;
      }
      intercept = false;
      await beforeFailure();
      throw new Error('alarm unavailable');
    },
  });
  try {
    return await operation();
  } finally {
    if (previousDescriptor === undefined) {
      Reflect.deleteProperty(storage, 'setAlarm');
    } else {
      Object.defineProperty(storage, 'setAlarm', previousDescriptor);
    }
  }
}

async function concurrentAlarmFailure(
  stub: DurableObjectStub<SessionCoordinator>,
  operation: Extract<SessionDownloadPermitOperation, 'acquire' | 'renew'>,
  input: SessionDownloadPermitRequestInput,
): Promise<{
  readonly firstStatus: number;
  readonly replayBlocked: boolean;
  readonly replayStatus: number;
}> {
  return runInDurableObject(stub, (instance) => {
    const started = deferred<void>();
    const failure = deferred<void>();
    return withFailNextAlarm(
      instance,
      async () => {
        started.resolve(undefined);
        await failure.promise;
      },
      async () => {
        const first = instance.fetch(sessionDownloadPermitRequest(operation, input));
        await started.promise;
        let replaySettled = false;
        const replay = instance
          .fetch(sessionDownloadPermitRequest(operation, input))
          .then((response) => {
            replaySettled = true;
            return response;
          });
        await Promise.resolve();
        const replayBlocked = !replaySettled;
        failure.resolve(undefined);
        return {
          firstStatus: (await first).status,
          replayBlocked,
          replayStatus: (await replay).status,
        };
      },
    );
  });
}

async function renewSessionDownloadPermitWithAlarmFailure(
  stub: DurableObjectStub<SessionCoordinator>,
  input: SessionDownloadPermitRequestInput,
): Promise<Response> {
  return runInDurableObject(stub, (instance) =>
    withFailNextAlarm(
      instance,
      () => undefined,
      () => instance.fetch(sessionDownloadPermitRequest('renew', input)),
    ),
  );
}

async function readSessionDownloadSnapshot(
  stub: DurableObjectStub<SessionCoordinator>,
): Promise<SessionDownloadSnapshot> {
  return runInDurableObject(stub, async (_instance, state) => ({
    alarmAt: await state.storage.getAlarm(),
    permits: state.storage.sql
      .exec<SessionDownloadPermitRow>(
        `SELECT permit_id, download_id, sequence, acquired_at, renewed_at, expires_at
         FROM session_download_permits ORDER BY permit_id`,
      )
      .toArray(),
  }));
}

async function resetSessionDownloadPermitMutationAudit(
  stub: DurableObjectStub<SessionCoordinator>,
): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS test_session_download_permit_mutations (
         mutation_id INTEGER PRIMARY KEY
       )`,
    );
    for (const operation of ['INSERT', 'UPDATE', 'DELETE'] as const) {
      state.storage.sql.exec(
        `CREATE TRIGGER IF NOT EXISTS test_session_download_permit_${operation.toLowerCase()}
         AFTER ${operation} ON session_download_permits
         BEGIN
           INSERT INTO test_session_download_permit_mutations (mutation_id) VALUES (NULL);
         END`,
      );
    }
    state.storage.sql.exec('DELETE FROM test_session_download_permit_mutations');
  });
}

async function readSessionDownloadPermitMutationCount(
  stub: DurableObjectStub<SessionCoordinator>,
): Promise<number> {
  return runInDurableObject(
    stub,
    (_instance, state) =>
      state.storage.sql
        .exec<SessionDownloadPermitMutationCountRow>(
          'SELECT COUNT(*) AS count FROM test_session_download_permit_mutations',
        )
        .one().count,
  );
}

async function expectSessionDownloadStorageUnchanged(
  stub: DurableObjectStub<SessionCoordinator>,
  before: SessionDownloadSnapshot,
): Promise<void> {
  expect(await readSessionDownloadPermitMutationCount(stub)).toBe(0);
  expect(await readSessionDownloadSnapshot(stub)).toEqual(before);
}

async function expireSessionDownloadPermit(
  stub: DurableObjectStub<SessionCoordinator>,
  permitId: string,
): Promise<readonly string[]> {
  return runInDurableObject(stub, (_instance, state) => {
    const expiredAt = Date.now() - 1;
    return state.storage.sql
      .exec<SessionDownloadPermitIdRow>(
        `UPDATE session_download_permits
         SET acquired_at = ?, renewed_at = ?, expires_at = ?
         WHERE permit_id = ?
         RETURNING permit_id`,
        expiredAt - 2,
        expiredAt - 1,
        expiredAt,
        permitId,
      )
      .toArray()
      .map((row) => row.permit_id);
  });
}

async function readSessionDownloadPermits(
  stub: DurableObjectStub<SessionCoordinator>,
): Promise<SessionDownloadPermitRow[]> {
  return [...(await readSessionDownloadSnapshot(stub)).permits];
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
                b.staging_expires_at, b.shortcode,
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
    (await bootstrap(stub, { sessionHash, csrfHash, issuedAt: now, expiresAt: now + 3_600_000 }))
      .status,
  ).toBe(200);
  expect((await acquirePermit(stub, sessionHash, csrfHash, permitId, now)).status).toBe(201);
  return { stub, sessionHash, csrfHash, permitId, now };
}

describe('SessionCoordinator in workerd', () => {
  it('creates, resumes, and replaces browser sessions through SELF', async () => {
    const clientIp = '203.0.113.41';
    const first = await SELF.fetch('https://session.test/api/session', {
      headers: { 'CF-Connecting-IP': clientIp },
    });
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
      headers: {
        'CF-Connecting-IP': clientIp,
        cookie: `__Host-td_session=${tampered}`,
      },
    });
    expect(replaced.status).toBe(200);
    expect(cookieValue(replaced)).not.toBe(signedCookie);

    const issuanceRows = await runInDurableObject(
      await issuanceLimiterStub(clientIp),
      (_instance, state) =>
        state.storage.sql
          .exec('SELECT event_at, reservation_expires_at FROM ip_session_issuance')
          .toArray(),
    );
    expect(issuanceRows).toHaveLength(2);
  });

  it('charges a replacement after alarm cleanup without resurrecting the signed stale cookie', async () => {
    const clientIp = '203.0.113.42';
    const first = await SELF.fetch('https://session.test/api/session', {
      headers: { 'CF-Connecting-IP': clientIp },
    });
    const signedCookie = cookieValue(first);
    const rawId = signedCookie.split('.', 1)[0]!;
    const oldStub = sessionStub(rawId);
    await runInDurableObject(oldStub, (_instance, state) => {
      state.storage.sql.exec('UPDATE session_record SET expires_at = ?', Date.now() - 1);
    });
    await expect(runDurableObjectAlarm(oldStub)).resolves.toBe(true);

    const replacement = await SELF.fetch('https://session.test/api/session', {
      headers: {
        'CF-Connecting-IP': clientIp,
        cookie: `__Host-td_session=${signedCookie}`,
      },
    });
    const replacementBody = (await replacement.json()) as SessionBody;
    const replacementCookie = cookieValue(replacement);
    expect(replacement.status).toBe(200);
    expect(replacementCookie).not.toBe(signedCookie);
    expect(await readRows(oldStub)).toHaveLength(0);

    const resumed = await SELF.fetch('https://session.test/api/session', {
      headers: { cookie: `__Host-td_session=${replacementCookie}` },
    });
    const resumedBody = (await resumed.json()) as SessionBody;
    expect(resumed.status).toBe(200);
    expect(resumed.headers.get('set-cookie')).toBeNull();
    expect(resumedBody.expiresAt).toBe(replacementBody.expiresAt);

    const issuanceRows = await runInDurableObject(
      await issuanceLimiterStub(clientIp),
      (_instance, state) =>
        state.storage.sql
          .exec('SELECT event_at, reservation_expires_at FROM ip_session_issuance')
          .toArray(),
    );
    expect(issuanceRows).toHaveLength(2);
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

  it('keeps permit mutations unauthorized when the session record is absent', async () => {
    const stub = sessionStub('missing-permit-session');
    const sessionHash = await hashIdentifier('missing-permit-session');
    const downloadId = createOpaqueId();
    const permitId = createOpaqueId();

    for (const [operation, request] of [
      ['acquire', { sessionHash, downloadId, permitId }],
      ['renew', { sessionHash, downloadId, permitId, sequence: 1 }],
      ['release', { sessionHash, downloadId, permitId }],
    ] as const) {
      expect((await sessionDownloadPermit(stub, operation, request)).status).toBe(401);
    }
    expect((await releasePermit(stub, sessionHash, permitId, Date.now())).status).toBe(401);
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
    const bootstrapAgain = await resumeCoordinator(stub, sessionHash, rotatedHash);
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

  it('limits browser-session downloads across download objects with exact lease transitions', async () => {
    const rawId = 'concurrent-download-session';
    const rawCsrf = 'concurrent-download-csrf';
    const sessionHash = await hashIdentifier(rawId);
    const csrfHash = await hashIdentifier(rawCsrf);
    const now = Date.now();
    const stub = sessionStub(rawId);
    await bootstrap(stub, { sessionHash, csrfHash, issuedAt: now, expiresAt: now + 600_000 });
    const downloadId = createOpaqueId();
    const otherDownloadId = createOpaqueId();
    const permitIds = Array.from({ length: 5 }, () => createOpaqueId());
    let firstAcquireBody: Record<string, unknown> | undefined;

    for (const [index, permitId] of permitIds.slice(0, 4).entries()) {
      const response = await sessionDownloadPermit(stub, 'acquire', {
        sessionHash,
        downloadId,
        permitId,
      });
      expect(response.status).toBe(201);
      if (index === 0) {
        firstAcquireBody = (await response.json()) as Record<string, unknown>;
      }
    }
    expect(firstAcquireBody?.['expiresAt']).toEqual(expect.any(Number));
    expect(firstAcquireBody?.['expiresAt']).toBeGreaterThan(now);
    expect(firstAcquireBody?.['expiresAt']).toBeLessThanOrEqual(Date.now() + 90_000);
    expect(
      (
        await sessionDownloadPermit(stub, 'acquire', {
          sessionHash,
          downloadId: otherDownloadId,
          permitId: permitIds[4]!,
        })
      ).status,
    ).toBe(429);
    await resetSessionDownloadPermitMutationAudit(stub);
    const beforeWrongHash = await readSessionDownloadSnapshot(stub);
    const wrongHash = await hashIdentifier('wrong-download-session');
    for (const [operation, request] of [
      ['acquire', { sessionHash: wrongHash, downloadId, permitId: createOpaqueId() }],
      ['renew', { sessionHash: wrongHash, downloadId, permitId: permitIds[0]!, sequence: 1 }],
      ['release', { sessionHash: wrongHash, downloadId, permitId: permitIds[0]! }],
    ] as const) {
      expect((await sessionDownloadPermit(stub, operation, request)).status).toBe(401);
    }
    await expectSessionDownloadStorageUnchanged(stub, beforeWrongHash);
    const replay = await sessionDownloadPermit(stub, 'acquire', {
      sessionHash,
      downloadId,
      permitId: permitIds[0]!,
    });
    await expect(replay.json()).resolves.toMatchObject({ ok: true, sequence: 0 });
    expect(
      (
        await sessionDownloadPermit(stub, 'acquire', {
          sessionHash,
          downloadId: otherDownloadId,
          permitId: permitIds[0]!,
        })
      ).status,
    ).toBe(409);

    await resetSessionDownloadPermitMutationAudit(stub);
    const beforeRenewal = await readSessionDownloadSnapshot(stub);
    const targetBeforeRenewal = beforeRenewal.permits.find(
      (row) => row.permit_id === permitIds[0],
    )!;
    const peersBeforeRenewal = beforeRenewal.permits.filter(
      (row) => row.permit_id !== permitIds[0],
    );
    const renewed = await sessionDownloadPermit(stub, 'renew', {
      sessionHash,
      downloadId,
      permitId: permitIds[0]!,
      sequence: 1,
    });
    const renewedBody = (await renewed.json()) as Record<string, unknown>;
    expect(renewed.status).toBe(200);
    expect(renewedBody).toMatchObject({ ok: true, sequence: 1 });
    const afterRenewal = await readSessionDownloadSnapshot(stub);
    expect(await readSessionDownloadPermitMutationCount(stub)).toBe(1);
    expect(afterRenewal.permits.filter((row) => row.permit_id !== permitIds[0])).toEqual(
      peersBeforeRenewal,
    );
    const renewedTarget = afterRenewal.permits.find((row) => row.permit_id === permitIds[0])!;
    expect(renewedTarget).toMatchObject({
      permit_id: targetBeforeRenewal.permit_id,
      download_id: targetBeforeRenewal.download_id,
      sequence: 1,
      acquired_at: targetBeforeRenewal.acquired_at,
      expires_at: renewedBody['expiresAt'],
    });
    expect(renewedTarget.renewed_at).toBeGreaterThanOrEqual(targetBeforeRenewal.renewed_at);
    expect(renewedTarget.renewed_at).toBeLessThan(renewedTarget.expires_at);

    await resetSessionDownloadPermitMutationAudit(stub);
    const beforeRenewReplay = await readSessionDownloadSnapshot(stub);
    const renewReplay = await sessionDownloadPermit(stub, 'renew', {
      sessionHash,
      downloadId,
      permitId: permitIds[0]!,
      sequence: 1,
    });
    await expect(renewReplay.json()).resolves.toEqual(renewedBody);
    await expectSessionDownloadStorageUnchanged(stub, beforeRenewReplay);

    await resetSessionDownloadPermitMutationAudit(stub);
    const beforeSkippedSequence = await readSessionDownloadSnapshot(stub);
    expect(
      (
        await sessionDownloadPermit(stub, 'renew', {
          sessionHash,
          downloadId,
          permitId: permitIds[0]!,
          sequence: 3,
        })
      ).status,
    ).toBe(409);
    await expectSessionDownloadStorageUnchanged(stub, beforeSkippedSequence);
    expect(
      (
        await sessionDownloadPermit(stub, 'release', {
          sessionHash,
          downloadId: otherDownloadId,
          permitId: permitIds[0]!,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await sessionDownloadPermit(stub, 'release', {
          sessionHash,
          downloadId,
          permitId: permitIds[0]!,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await sessionDownloadPermit(stub, 'release', {
          sessionHash,
          downloadId,
          permitId: permitIds[0]!,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await sessionDownloadPermit(stub, 'acquire', {
          sessionHash,
          downloadId: otherDownloadId,
          permitId: permitIds[4]!,
        })
      ).status,
    ).toBe(201);

    const stored = await readSessionDownloadPermits(stub);
    expect(stored).toHaveLength(4);
    expect(stored.find((row) => row['permit_id'] === permitIds[4])?.['download_id']).toBe(
      otherDownloadId,
    );
    expect(JSON.stringify(stored)).not.toContain(rawId);
    expect(JSON.stringify(stored)).not.toContain(rawCsrf);
    expect(JSON.stringify(stored)).not.toContain(privateMediaUrl);
  });

  it('prunes only the expired download row and preserves the live alarm deadline', async () => {
    const rawId = 'expiring-download-permit-session';
    const sessionHash = await hashIdentifier(rawId);
    const csrfHash = await hashIdentifier('expiring-download-permit-csrf');
    const now = Date.now();
    const stub = sessionStub(rawId);
    await bootstrap(stub, { sessionHash, csrfHash, issuedAt: now, expiresAt: now + 600_000 });
    const downloadId = createOpaqueId();
    const livePermitId = createOpaqueId();
    const expiredPermitId = createOpaqueId();
    expect(
      (
        await sessionDownloadPermit(stub, 'acquire', {
          sessionHash,
          downloadId,
          permitId: livePermitId,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await sessionDownloadPermit(stub, 'acquire', {
          sessionHash,
          downloadId,
          permitId: expiredPermitId,
        })
      ).status,
    ).toBe(201);
    await expect(expireSessionDownloadPermit(stub, expiredPermitId)).resolves.toEqual([
      expiredPermitId,
    ]);
    await resetSessionDownloadPermitMutationAudit(stub);
    const beforeAlarm = await readSessionDownloadSnapshot(stub);
    const livePermit = beforeAlarm.permits.find((row) => row.permit_id === livePermitId)!;
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
    const afterAlarm = await readSessionDownloadSnapshot(stub);
    expect(await readSessionDownloadPermitMutationCount(stub)).toBe(1);
    expect(afterAlarm.permits).toEqual([livePermit]);
    expect(afterAlarm.alarmAt).toBe(livePermit.expires_at);
  });

  it('renews one target and deletes only expired siblings', async () => {
    const rawId = 'targeted-download-renewal-session';
    const sessionHash = await hashIdentifier(rawId);
    const csrfHash = await hashIdentifier('targeted-download-renewal-csrf');
    const now = Date.now();
    const stub = sessionStub(rawId);
    await bootstrap(stub, { sessionHash, csrfHash, issuedAt: now, expiresAt: now + 600_000 });
    const downloadId = createOpaqueId();
    const targetPermitId = createOpaqueId();
    const livePeerId = createOpaqueId();
    const expiredPeerId = createOpaqueId();
    for (const permitId of [targetPermitId, livePeerId, expiredPeerId]) {
      expect(
        (await sessionDownloadPermit(stub, 'acquire', { sessionHash, downloadId, permitId }))
          .status,
      ).toBe(201);
    }
    await expect(expireSessionDownloadPermit(stub, expiredPeerId)).resolves.toEqual([
      expiredPeerId,
    ]);
    await resetSessionDownloadPermitMutationAudit(stub);
    const before = await readSessionDownloadSnapshot(stub);
    const targetBefore = before.permits.find((row) => row.permit_id === targetPermitId)!;
    const livePeerBefore = before.permits.find((row) => row.permit_id === livePeerId)!;

    expect(
      (
        await sessionDownloadPermit(stub, 'renew', {
          sessionHash,
          downloadId,
          permitId: targetPermitId,
          sequence: 1,
        })
      ).status,
    ).toBe(200);
    const after = await readSessionDownloadSnapshot(stub);
    expect(await readSessionDownloadPermitMutationCount(stub)).toBe(2);
    expect(after.permits.find((row) => row.permit_id === expiredPeerId)).toBeUndefined();
    expect(after.permits.find((row) => row.permit_id === livePeerId)).toEqual(livePeerBefore);
    expect(after.permits.find((row) => row.permit_id === targetPermitId)).toMatchObject({
      permit_id: targetBefore.permit_id,
      download_id: targetBefore.download_id,
      sequence: 1,
      acquired_at: targetBefore.acquired_at,
    });
  });

  it('rejects renewal when a peer permit is corrupt without mutating storage', async () => {
    const rawId = 'corrupt-peer-download-session';
    const sessionHash = await hashIdentifier(rawId);
    const csrfHash = await hashIdentifier('corrupt-peer-download-csrf');
    const now = Date.now();
    const stub = sessionStub(rawId);
    await bootstrap(stub, { sessionHash, csrfHash, issuedAt: now, expiresAt: now + 600_000 });
    const downloadId = createOpaqueId();
    const targetPermitId = createOpaqueId();
    const corruptPeerId = createOpaqueId();
    for (const permitId of [targetPermitId, corruptPeerId]) {
      expect(
        (await sessionDownloadPermit(stub, 'acquire', { sessionHash, downloadId, permitId }))
          .status,
      ).toBe(201);
    }
    const corruptedRows = await runInDurableObject(
      stub,
      (_instance, state) =>
        state.storage.sql.exec(
          'UPDATE session_download_permits SET sequence = -1 WHERE permit_id = ?',
          corruptPeerId,
        ).rowsWritten,
    );
    expect(corruptedRows).toBe(1);
    await resetSessionDownloadPermitMutationAudit(stub);
    const before = await readSessionDownloadSnapshot(stub);

    expect(
      (
        await sessionDownloadPermit(stub, 'renew', {
          sessionHash,
          downloadId,
          permitId: createOpaqueId(),
          sequence: 1,
        })
      ).status,
    ).toBe(409);
    await expectSessionDownloadStorageUnchanged(stub, before);
    expect(
      (
        await sessionDownloadPermit(stub, 'renew', {
          sessionHash,
          downloadId,
          permitId: targetPermitId,
          sequence: 1,
        })
      ).status,
    ).toBe(500);
    await expectSessionDownloadStorageUnchanged(stub, before);
  });

  it('rejects acquire and renew without a useful session lease window and preserves capacity', async () => {
    const rawId = 'short-window-download-session';
    const sessionHash = await hashIdentifier(rawId);
    const csrfHash = await hashIdentifier('short-window-download-csrf');
    const now = Date.now();
    const stub = sessionStub(rawId);
    await bootstrap(stub, { sessionHash, csrfHash, issuedAt: now, expiresAt: now + 600_000 });
    const downloadId = createOpaqueId();
    const permitId = createOpaqueId();
    expect(
      (await sessionDownloadPermit(stub, 'acquire', { sessionHash, downloadId, permitId })).status,
    ).toBe(201);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec('UPDATE session_record SET expires_at = ?', Date.now() + 44_000);
    });
    const before = await readSessionDownloadPermits(stub);

    expect(
      (
        await sessionDownloadPermit(stub, 'acquire', {
          sessionHash,
          downloadId,
          permitId: createOpaqueId(),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await sessionDownloadPermit(stub, 'renew', {
          sessionHash,
          downloadId,
          permitId,
          sequence: 1,
        })
      ).status,
    ).toBe(401);
    expect(await readSessionDownloadPermits(stub)).toEqual(before);
  });

  it('serializes acquire alarm compensation before an idempotent replay can observe the row', async () => {
    const rawId = 'serialized-download-acquire';
    const sessionHash = await hashIdentifier(rawId);
    const csrfHash = await hashIdentifier('serialized-download-acquire-csrf');
    const now = Date.now();
    const stub = sessionStub(rawId);
    await bootstrap(stub, { sessionHash, csrfHash, issuedAt: now, expiresAt: now + 600_000 });
    const binding = {
      sessionHash,
      downloadId: createOpaqueId(),
      permitId: createOpaqueId(),
    };
    const result = await concurrentAlarmFailure(stub, 'acquire', binding);
    expect(result).toEqual({ firstStatus: 500, replayBlocked: true, replayStatus: 201 });
    expect(await readSessionDownloadPermits(stub)).toHaveLength(1);
  });

  it('reverse-CASes a failed renewal exactly before a serialized replay', async () => {
    const rawId = 'serialized-download-renew';
    const sessionHash = await hashIdentifier(rawId);
    const csrfHash = await hashIdentifier('serialized-download-renew-csrf');
    const now = Date.now();
    const stub = sessionStub(rawId);
    await bootstrap(stub, { sessionHash, csrfHash, issuedAt: now, expiresAt: now + 600_000 });
    const binding = {
      sessionHash,
      downloadId: createOpaqueId(),
      permitId: createOpaqueId(),
    };
    const livePeerIds = [createOpaqueId(), createOpaqueId()];
    const expiredPeerId = createOpaqueId();
    for (const permitId of [binding.permitId, ...livePeerIds, expiredPeerId]) {
      expect(
        (
          await sessionDownloadPermit(stub, 'acquire', {
            sessionHash,
            downloadId: binding.downloadId,
            permitId,
          })
        ).status,
      ).toBe(201);
    }
    await expect(expireSessionDownloadPermit(stub, expiredPeerId)).resolves.toEqual([
      expiredPeerId,
    ]);
    const renewal = { ...binding, sequence: 1 };

    await resetSessionDownloadPermitMutationAudit(stub);
    const beforeFailure = await readSessionDownloadSnapshot(stub);
    expect((await renewSessionDownloadPermitWithAlarmFailure(stub, renewal)).status).toBe(500);
    const afterFailure = await readSessionDownloadSnapshot(stub);
    expect(await readSessionDownloadPermitMutationCount(stub)).toBe(3);
    expect(afterFailure.permits).toEqual(
      beforeFailure.permits.filter((row) => row.permit_id !== expiredPeerId),
    );
    expect(afterFailure.alarmAt).toBe(beforeFailure.alarmAt);

    await resetSessionDownloadPermitMutationAudit(stub);
    const beforeSerializedReplay = await readSessionDownloadSnapshot(stub);
    const peersBeforeSerializedReplay = beforeSerializedReplay.permits.filter(
      (row) => row.permit_id !== binding.permitId,
    );
    const result = await concurrentAlarmFailure(stub, 'renew', renewal);
    expect(result).toEqual({ firstStatus: 500, replayBlocked: true, replayStatus: 200 });
    const afterSerializedReplay = await readSessionDownloadSnapshot(stub);
    expect(await readSessionDownloadPermitMutationCount(stub)).toBe(3);
    expect(
      afterSerializedReplay.permits.filter((row) => row.permit_id !== binding.permitId),
    ).toEqual(peersBeforeSerializedReplay);
    expect(
      afterSerializedReplay.permits.find((row) => row.permit_id === binding.permitId)?.sequence,
    ).toBe(1);
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
    const acquisition = await acquirePermit(stub, sessionHash, csrfHash, permitId, now);
    expect(acquisition.status).toBe(201);
    await expect(acquisition.json()).resolves.toEqual({
      ok: true,
      expiresAt: now + RESOLVE_PERMIT_LEASE_MS,
    });

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
    expect(stored.expiresAt - stored.issuedAt).toBeLessThanOrEqual(RESOLVE_VAULT_TTL_MS);
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
    expect(rows.every((row) => row.shortcode === 'Abcde_1')).toBe(true);
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
    expect(firstClaimBody.filename).toBe('threads_Abcde_1_1.mp4');
    expect(firstClaimBody.shortcode).toBe('Abcde_1');
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
    const repeatedReservation = createOpaqueId();
    expect(
      (
        await claimVault(stub, {
          sessionHash,
          csrfHash,
          now: now + 9,
          resolveId: stored.resolveId,
          candidateId,
          reservationId: repeatedReservation,
        })
      ).status,
    ).toBe(200);
    expect((await settleVault(stub, { ...consumed, now: now + 10 })).status).toBe(200);
    expect(
      (
        await claimVault(stub, {
          sessionHash,
          csrfHash,
          now: now + 11,
          resolveId: stored.resolveId,
          candidateId,
          reservationId: createOpaqueId(),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await settleVault(stub, {
          sessionHash,
          csrfHash,
          now: now + 12,
          resolveId: stored.resolveId,
          candidateId,
          reservationId: repeatedReservation,
          outcome: 'release',
        })
      ).status,
    ).toBe(200);

    expect(
      (
        await claimVault(sessionStub('vault-lifecycle-session'), {
          sessionHash,
          csrfHash,
          now: now + 13,
          resolveId: stored.resolveId,
          candidateId: stored.candidates[1]!.candidateId,
          reservationId: createOpaqueId(),
        })
      ).status,
    ).toBe(200);
  });

  it('treats consume as a non-destructive acknowledgement while the candidate exists', async () => {
    const context = await prepareVaultSession('vault-consume-tombstone-session');
    const storedResponse = await storeVault(context.stub, context);
    const stored = (await storedResponse.json()) as StoredVaultBatch;
    const candidateId = stored.candidates[0]!.candidateId;
    const expiredReservation = createOpaqueId();
    expect(
      (
        await claimVault(context.stub, {
          sessionHash: context.sessionHash,
          csrfHash: context.csrfHash,
          now: context.now,
          resolveId: stored.resolveId,
          candidateId,
          reservationId: expiredReservation,
        })
      ).status,
    ).toBe(200);
    await runInDurableObject(context.stub, (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE resolved_media_candidates SET reservation_expires_at = ? WHERE resolve_id = ?',
        Date.now() - 1,
        stored.resolveId,
      );
    });

    const consumingReservation = createOpaqueId();
    expect(
      (
        await claimVault(context.stub, {
          sessionHash: context.sessionHash,
          csrfHash: context.csrfHash,
          now: context.now,
          resolveId: stored.resolveId,
          candidateId,
          reservationId: consumingReservation,
        })
      ).status,
    ).toBe(200);
    const settlement = {
      sessionHash: context.sessionHash,
      csrfHash: context.csrfHash,
      now: context.now + 1,
      resolveId: stored.resolveId,
      candidateId,
      outcome: 'consume' as const,
    };
    expect(
      (
        await settleVault(context.stub, {
          ...settlement,
          reservationId: consumingReservation,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await settleVault(context.stub, {
          ...settlement,
          reservationId: expiredReservation,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await settleVault(context.stub, {
          ...settlement,
          reservationId: consumingReservation,
        })
      ).status,
    ).toBe(200);

    const tombstones = await runInDurableObject(context.stub, (_instance, state) =>
      state.storage.sql
        .exec<{ reservation_id: string }>('SELECT reservation_id FROM resolved_media_consumptions')
        .toArray(),
    );
    expect(tombstones).toEqual([]);
  });

  it('uses the fresh object clock and caps batch expiry at the session or ten minutes', async () => {
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

    const futureCallerClock = Number.MAX_SAFE_INTEGER - RESOLVE_VAULT_TTL_MS;
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

    const longSession = await prepareVaultSession('vault-ten-minute-session');
    const longResponse = await storeVault(longSession.stub, longSession);
    expect(longResponse.status).toBe(201);
    const [longRow] = await readVaultRows(longSession.stub);
    expect(longRow!.expires_at - longRow!.issued_at).toBe(RESOLVE_VAULT_TTL_MS);
  });

  it('keeps a consumed candidate reusable at 599 seconds and expires it at 600 seconds', async () => {
    const context = await prepareVaultSession('vault-reusable-boundary-session');
    const storedResponse = await storeVault(context.stub, context);
    expect(storedResponse.status).toBe(201);
    const stored = (await storedResponse.json()) as StoredVaultBatch;
    const candidate = stored.candidates[0]!;
    const firstReservation = createOpaqueId();

    expect(
      (
        await claimVault(context.stub, {
          sessionHash: context.sessionHash,
          csrfHash: context.csrfHash,
          now: context.now,
          resolveId: stored.resolveId,
          candidateId: candidate.candidateId,
          reservationId: firstReservation,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await settleVault(context.stub, {
          sessionHash: context.sessionHash,
          csrfHash: context.csrfHash,
          now: context.now,
          resolveId: stored.resolveId,
          candidateId: candidate.candidateId,
          reservationId: firstReservation,
          outcome: 'consume',
        })
      ).status,
    ).toBe(200);

    await runInDurableObject(context.stub, async (instance, state) => {
      const issuedAt = Date.now() - 599_000;
      const expiresAt = issuedAt + RESOLVE_VAULT_TTL_MS;
      const codec = await (
        instance as unknown as { grantCodec(): Promise<ResolvedMediaGrantCodec> }
      ).grantCodec();
      const sealedGrant = await codec.seal(
        probedMedia(),
        {
          sessionHash: context.sessionHash,
          resolveId: stored.resolveId,
          candidateId: candidate.candidateId,
          ordinal: 1,
          filename: candidate.filename,
          shortcode: 'Abcde_1',
          contentLength: candidate.contentLength ?? null,
          issuedAt,
          expiresAt,
        },
        issuedAt,
      );
      state.storage.sql.exec(
        'UPDATE resolved_media_batches SET issued_at = ?, expires_at = ? WHERE resolve_id = ?',
        issuedAt,
        expiresAt,
        stored.resolveId,
      );
      state.storage.sql.exec(
        `UPDATE resolved_media_candidates SET sealed_grant = ?
         WHERE resolve_id = ? AND candidate_id = ?`,
        sealedGrant,
        stored.resolveId,
        candidate.candidateId,
      );
    });

    const secondReservation = createOpaqueId();
    expect(
      (
        await claimVault(context.stub, {
          sessionHash: context.sessionHash,
          csrfHash: context.csrfHash,
          now: Date.now(),
          resolveId: stored.resolveId,
          candidateId: candidate.candidateId,
          reservationId: secondReservation,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await settleVault(context.stub, {
          sessionHash: context.sessionHash,
          csrfHash: context.csrfHash,
          now: Date.now(),
          resolveId: stored.resolveId,
          candidateId: candidate.candidateId,
          reservationId: secondReservation,
          outcome: 'consume',
        })
      ).status,
    ).toBe(200);

    await runInDurableObject(context.stub, (_instance, state) => {
      const expiresAt = Date.now();
      state.storage.sql.exec(
        'UPDATE resolved_media_batches SET issued_at = ?, expires_at = ? WHERE resolve_id = ?',
        expiresAt - RESOLVE_VAULT_TTL_MS,
        expiresAt,
        stored.resolveId,
      );
    });
    expect(
      (
        await claimVault(context.stub, {
          sessionHash: context.sessionHash,
          csrfHash: context.csrfHash,
          now: Date.now(),
          resolveId: stored.resolveId,
          candidateId: candidate.candidateId,
          reservationId: createOpaqueId(),
        })
      ).status,
    ).toBe(404);
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
    ).toBe(200);
    const [availableAfterLateConsume] = await readVaultRows(context.stub);
    expect(availableAfterLateConsume?.reservation_id).toBeNull();
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

  it('rejects a stored shortcode that no longer matches the authenticated media grant', async () => {
    const context = await prepareVaultSession('vault-shortcode-authority-session');
    const storedResponse = await storeVault(context.stub, {
      ...context,
      shortcode: 'Original_1',
    });
    const stored = (await storedResponse.json()) as StoredVaultBatch;

    await runInDurableObject(context.stub, (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE resolved_media_batches SET shortcode = ? WHERE resolve_id = ?',
        'Forged_2',
        stored.resolveId,
      );
    });

    const response = await claimVault(context.stub, {
      sessionHash: context.sessionHash,
      csrfHash: context.csrfHash,
      now: context.now + 1,
      resolveId: stored.resolveId,
      candidateId: stored.candidates[0]!.candidateId,
      reservationId: createOpaqueId(),
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false });
    expect(await readVaultRows(context.stub)).toEqual([]);
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

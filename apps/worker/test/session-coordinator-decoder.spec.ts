import { describe, expect, it, vi } from 'vitest';

import {
  decodeAcquireResolvePermitRequest,
  decodeAuthorizeSessionRequest,
  decodeBootstrapSessionRequest,
  decodeReleaseResolvePermitRequest,
  SessionCoordinator,
  type SessionCoordinatorEnv,
} from '../src/session-coordinator.js';
import { encodeBase64Url } from '../src/utils/base64url.js';

const sessionHash = 'A'.repeat(43);
const csrfHash = 'B'.repeat(43);
const permitId = 'C'.repeat(22);
const vaultSessionHash = encodeBase64Url(new Uint8Array(32).fill(1));
const vaultCsrfHash = encodeBase64Url(new Uint8Array(32).fill(2));
const vaultPermitId = encodeBase64Url(new Uint8Array(24).fill(3));
const vaultResolveId = encodeBase64Url(new Uint8Array(24).fill(4));
const vaultCandidateId = encodeBase64Url(new Uint8Array(24).fill(5));
const vaultReservationId = encodeBase64Url(new Uint8Array(24).fill(6));
const vaultCandidateWire = {
  finalUrl: 'https://video.cdninstagram.com/media/test.mp4',
  contentType: 'video/mp4',
  contentLength: 42,
  rangeCapability: 'bytes',
  strongEtag: '"test-etag"',
  lastModified: null,
  completionReliable: true,
  probeMethod: 'head',
} as const;

describe('SessionCoordinator internal request decoders', () => {
  it('decodes only the exact bootstrap shape', () => {
    const valid = { sessionHash, csrfHash, issuedAt: 100, expiresAt: 200 };
    expect(decodeBootstrapSessionRequest(valid)).toEqual(valid);
    expect(decodeBootstrapSessionRequest({ ...valid, rawId: 'must-not-pass' })).toBeNull();
    expect(decodeBootstrapSessionRequest({ ...valid, expiresAt: '200' })).toBeNull();
  });

  it('decodes only the exact authorize shape', () => {
    const valid = { sessionHash, csrfHash, now: 100 };
    expect(decodeAuthorizeSessionRequest(valid)).toEqual(valid);
    expect(decodeAuthorizeSessionRequest({ ...valid, token: 'must-not-pass' })).toBeNull();
    expect(decodeAuthorizeSessionRequest({ ...valid, csrfHash: null })).toBeNull();
  });

  it('decodes only the exact permit acquisition shape', () => {
    const valid = { sessionHash, csrfHash, permitId, now: 100 };
    expect(decodeAcquireResolvePermitRequest(valid)).toEqual(valid);
    expect(decodeAcquireResolvePermitRequest({ ...valid, rawSession: 'must-not-pass' })).toBeNull();
    expect(decodeAcquireResolvePermitRequest({ ...valid, permitId: 42 })).toBeNull();
  });

  it('decodes only the exact hash-only release shape', () => {
    const valid = { sessionHash, permitId, now: 100 };
    expect(decodeReleaseResolvePermitRequest(valid)).toEqual(valid);
    expect(decodeReleaseResolvePermitRequest({ ...valid, csrfHash })).toBeNull();
    expect(decodeReleaseResolvePermitRequest({ ...valid, now: '100' })).toBeNull();
  });

  it.each([
    decodeBootstrapSessionRequest,
    decodeAuthorizeSessionRequest,
    decodeAcquireResolvePermitRequest,
    decodeReleaseResolvePermitRequest,
  ])('rejects non-object internal payloads', (decoder) => {
    expect(decoder(null)).toBeNull();
    expect(decoder([])).toBeNull();
    expect(decoder('credential')).toBeNull();
  });
});

describe('SessionCoordinator request error contract', () => {
  function coordinator(record?: Record<string, string | number>): SessionCoordinator {
    const storage = {
      sql: {
        exec: vi.fn((query: string) => ({
          toArray: () =>
            query.startsWith('SELECT schema_version') && record !== undefined ? [record] : [],
        })),
      },
      transactionSync: <T>(callback: () => T): T => callback(),
      setAlarm: vi.fn(() => Promise.resolve()),
    };
    return new SessionCoordinator(
      { storage } as unknown as DurableObjectState,
      { RESOLVED_MEDIA_GRANT_KEY: 'unused-by-decoder-tests' } as SessionCoordinatorEnv,
    );
  }

  it.each([
    ['GET', '/bootstrap'],
    ['POST', '/missing'],
  ])('returns a safe 404 for unsupported internal requests', async (method, path) => {
    const response = await coordinator().fetch(
      new Request(`https://session.internal${path}`, { method }),
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ ok: false });
  });

  it.each([
    '/bootstrap',
    '/authorize',
    '/resolve-permits/acquire',
    '/resolve-permits/release',
    '/resolve-vault/store',
    '/resolve-vault/claim',
    '/resolve-vault/settle',
  ])('returns a safe 400 for malformed JSON at %s', async (path) => {
    const response = await coordinator().fetch(
      new Request(`https://session.internal${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{malformed credential body',
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ ok: false });
  });

  it.each([
    ['/authorize', { sessionHash, csrfHash, now: 100 }],
    ['/resolve-permits/acquire', { sessionHash, csrfHash, permitId, now: 100 }],
    ['/resolve-permits/release', { sessionHash, permitId, now: 100 }],
  ])('denies a valid %s request when the session is missing', async (path, body) => {
    const response = await coordinator().fetch(
      new Request(`https://session.internal${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ ok: false });
  });

  it.each([
    [
      '/resolve-vault/store',
      {
        sessionHash: vaultSessionHash,
        csrfHash: vaultCsrfHash,
        permitId: vaultPermitId,
        now: 100,
        shortcode: 'Abcde',
        candidates: [vaultCandidateWire],
      },
    ],
    [
      '/resolve-vault/claim',
      {
        sessionHash: vaultSessionHash,
        csrfHash: vaultCsrfHash,
        now: 100,
        resolveId: vaultResolveId,
        candidateId: vaultCandidateId,
        reservationId: vaultReservationId,
      },
    ],
    [
      '/resolve-vault/settle',
      {
        sessionHash: vaultSessionHash,
        csrfHash: vaultCsrfHash,
        now: 100,
        resolveId: vaultResolveId,
        candidateId: vaultCandidateId,
        reservationId: vaultReservationId,
        outcome: 'release',
      },
    ],
  ])('denies a valid %s vault request when the session is missing', async (path, body) => {
    const response = await coordinator().fetch(
      new Request(`https://session.internal${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ ok: false });
  });

  it.each([
    [
      '/resolve-vault/store',
      {
        sessionHash: vaultSessionHash,
        csrfHash: vaultCsrfHash,
        permitId: vaultPermitId,
        now: 0,
        shortcode: 'Abcde',
        candidates: [vaultCandidateWire],
      },
      409,
    ],
    [
      '/resolve-vault/claim',
      {
        sessionHash: vaultSessionHash,
        csrfHash: vaultCsrfHash,
        now: 0,
        resolveId: vaultResolveId,
        candidateId: vaultCandidateId,
        reservationId: vaultReservationId,
      },
      404,
    ],
    [
      '/resolve-vault/settle',
      {
        sessionHash: vaultSessionHash,
        csrfHash: vaultCsrfHash,
        now: 0,
        resolveId: vaultResolveId,
        candidateId: vaultCandidateId,
        reservationId: vaultReservationId,
        outcome: 'release',
      },
      200,
    ],
  ])('uses safe missing-state semantics for %s', async (path, body, expectedStatus) => {
    const now = Date.now();
    const response = await coordinator({
      schema_version: 1,
      session_hash: vaultSessionHash,
      csrf_hash: vaultCsrfHash,
      issued_at: now - 1_000,
      expires_at: now + 60_000,
    }).fetch(
      new Request(`https://session.internal${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    expect(response.status).toBe(expectedStatus);
    await expect(response.json()).resolves.toEqual(
      expectedStatus === 200 ? { ok: true } : { ok: false },
    );
  });
});

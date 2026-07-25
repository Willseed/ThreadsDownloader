import { describe, expect, it, vi } from 'vitest';

import {
  decodeAcquireResolvePermitRequest,
  decodeAuthorizeSessionRequest,
  decodeBootstrapSessionRequest,
  decodeReleaseResolvePermitRequest,
  SessionCoordinator,
} from '../src/session-coordinator.js';

const sessionHash = 'A'.repeat(43);
const csrfHash = 'B'.repeat(43);
const permitId = 'C'.repeat(22);

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
  function coordinator(): SessionCoordinator {
    const cursor = { toArray: () => [] };
    const storage = {
      sql: { exec: vi.fn(() => cursor) },
      transactionSync: <T>(callback: () => T): T => callback(),
    };
    return new SessionCoordinator(
      { storage } as unknown as DurableObjectState,
      {} as Cloudflare.Env,
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

  it.each(['/bootstrap', '/authorize', '/resolve-permits/acquire', '/resolve-permits/release'])(
    'returns a safe 400 for malformed JSON at %s',
    async (path) => {
      const response = await coordinator().fetch(
        new Request(`https://session.internal${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{malformed credential body',
        }),
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ ok: false });
    },
  );

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
});

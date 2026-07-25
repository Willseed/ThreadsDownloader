import { describe, expect, it, vi } from 'vitest';

import { decodeIpRateLimitRequest, IpRateLimiter } from '../src/ip-rate-limiter.js';
import { createOpaqueId } from '../src/security/cryptography.js';

const ipHash = 'ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0';

function limiter(): IpRateLimiter {
  const cursor = { toArray: () => [] };
  const storage = {
    deleteAlarm: vi.fn(async () => undefined),
    deleteAll: vi.fn(async () => undefined),
    setAlarm: vi.fn(async () => undefined),
    sql: { exec: vi.fn(() => cursor) },
    transactionSync: <T>(callback: () => T): T => callback(),
  };
  return new IpRateLimiter({ storage } as unknown as DurableObjectState, {} as Cloudflare.Env);
}

describe('IpRateLimiter internal request decoder', () => {
  it('accepts only the exact hash-only shape', () => {
    const valid = { ipHash, permitId: createOpaqueId(), now: 100 };
    expect(decodeIpRateLimitRequest(valid)).toEqual(valid);
    expect(decodeIpRateLimitRequest({ ...valid, rawIp: '203.0.113.42' })).toBeNull();
    expect(decodeIpRateLimitRequest({ ...valid, ipHash: 'A'.repeat(42) })).toBeNull();
    expect(decodeIpRateLimitRequest({ ...valid, ipHash: `${ipHash.slice(0, -1)}B` })).toBeNull();
    expect(decodeIpRateLimitRequest({ ...valid, permitId: 'short' })).toBeNull();
    expect(decodeIpRateLimitRequest({ ...valid, now: -1 })).toBeNull();
    expect(decodeIpRateLimitRequest({ ...valid, now: Number.MAX_SAFE_INTEGER })).toBeNull();
    expect(decodeIpRateLimitRequest({ ...valid, now: '100' })).toBeNull();
  });

  it.each([null, [], '203.0.113.42'])('rejects a non-object payload', (value) => {
    expect(decodeIpRateLimitRequest(value)).toBeNull();
  });
});

describe('IpRateLimiter request error contract', () => {
  it.each([
    ['GET', '/acquire'],
    ['POST', '/missing'],
  ])('returns a safe 404 for unsupported internal requests', async (method, path) => {
    const response = await limiter().fetch(
      new Request(`https://ip-rate-limit.internal${path}`, {
        method,
        ...(method === 'POST'
          ? {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ ipHash, permitId: createOpaqueId(), now: 100 }),
            }
          : {}),
      }),
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ ok: false });
  });

  it.each(['{malformed private address', JSON.stringify({ ipHash })])(
    'returns a safe 400 for malformed input',
    async (body) => {
      const response = await limiter().fetch(
        new Request('https://ip-rate-limit.internal/acquire', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        }),
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ ok: false });
    },
  );
});

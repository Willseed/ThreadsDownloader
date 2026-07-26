import { describe, expect, it, vi } from 'vitest';

import {
  reserveSessionIssuance,
  SessionIssuanceError,
  type SessionIssuanceRateLimitNamespace,
} from '../src/security/session-issuance.js';

function namespace(fetcher: (request: Request) => Promise<Response>): {
  readonly binding: SessionIssuanceRateLimitNamespace;
  readonly get: ReturnType<typeof vi.fn>;
} {
  const get = vi.fn(() => ({ fetch: fetcher }));
  return {
    binding: {
      idFromName: () => ({}) as DurableObjectId,
      get,
    },
    get,
  };
}

describe('session issuance client', () => {
  it('fails before the limiter DO when keyed IP hashing is unavailable', async () => {
    const limiter = namespace(async () => Response.json({ ok: true }));
    await expect(
      reserveSessionIssuance({
        headers: new Headers({ 'CF-Connecting-IP': '203.0.113.42' }),
        ipRateLimits: limiter.binding,
        signingKey: {} as CryptoKey,
        now: 100,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<SessionIssuanceError>>({
        code: 'SESSION_ISSUANCE_UNAVAILABLE',
      }),
    );
    expect(limiter.get).not.toHaveBeenCalled();
  });
});

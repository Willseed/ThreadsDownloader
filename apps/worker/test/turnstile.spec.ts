import { describe, expect, it, vi } from 'vitest';

import {
  createTurnstileVerifier,
  TurnstileError,
  type TurnstileReplayNamespace,
  verifyTurnstileOnce,
} from '../src/security/turnstile.js';

const now = Date.parse('2026-07-25T00:00:00.000Z');
const token = 'challenge-token-private';
const secret = crypto.randomUUID();

function siteverifyBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    success: true,
    hostname: 'threads.example',
    action: 'resolve',
    challenge_ts: new Date(now - 1_000).toISOString(),
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

async function expectSafeError(
  action: () => Promise<unknown>,
  code: string,
  sensitive = token,
): Promise<void> {
  try {
    await action();
    throw new Error('expected Turnstile error');
  } catch (error) {
    expect(error).toBeInstanceOf(TurnstileError);
    expect((error as TurnstileError).code).toBe(code);
    expect((error as Error).message).not.toContain(sensitive);
    expect((error as Error).message).not.toContain(secret);
  }
}

function verifier(fetcher: typeof fetch) {
  return createTurnstileVerifier({
    secret,
    expectedHostname: 'threads.example',
    fetcher,
    now: () => now,
  });
}

function replayNamespace(requests: unknown[] = []): TurnstileReplayNamespace {
  const consumed = new Set<string>();
  const ids = new Map<DurableObjectId, string>();
  return {
    idFromName(name) {
      const id = {} as DurableObjectId;
      ids.set(id, name);
      return id;
    },
    get(id) {
      return {
        async fetch(request) {
          const body: unknown = await request.json();
          requests.push(body);
          const hash = ids.get(id)!;
          if (consumed.has(hash)) {
            return Response.json({ ok: false }, { status: 409 });
          }
          consumed.add(hash);
          return Response.json({ ok: true }, { status: 201 });
        },
      };
    },
  };
}

describe('Turnstile production adapter', () => {
  it('posts only allowed FormData fields without credential headers', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
      expect(request.method).toBe('POST');
      expect(request.headers.has('cookie')).toBe(false);
      expect(request.headers.has('authorization')).toBe(false);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const form = await request.formData();
      expect([...form.keys()].sort()).toEqual([
        'idempotency_key',
        'remoteip',
        'response',
        'secret',
      ]);
      expect(form.get('secret')).toBe(secret);
      expect(form.get('response')).toBe(token);
      expect(form.get('remoteip')).toBe('203.0.113.1');
      expect(form.get('idempotency_key')).toBe('request-id');
      return jsonResponse(siteverifyBody());
    });

    await expect(
      verifier(fetcher).verify({ token, remoteIp: '203.0.113.1', idempotencyKey: 'request-id' }),
    ).resolves.toEqual({ challengeTimestamp: now - 1_000 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ success: false }, 'TURNSTILE_REJECTED'],
    [siteverifyBody({ hostname: 'attacker.example' }), 'TURNSTILE_REJECTED'],
    [siteverifyBody({ action: 'other' }), 'TURNSTILE_REJECTED'],
    [siteverifyBody({ challenge_ts: new Date(now - 300_001).toISOString() }), 'TURNSTILE_REJECTED'],
    [siteverifyBody({ challenge_ts: new Date(now + 30_001).toISOString() }), 'TURNSTILE_REJECTED'],
    [siteverifyBody({ challenge_ts: 'not-a-timestamp' }), 'TURNSTILE_REJECTED'],
    [siteverifyBody({ hostname: 42 }), 'TURNSTILE_REJECTED'],
  ])('rejects unsuccessful or policy-mismatched responses', async (body, code) => {
    await expectSafeError(() => verifier(async () => jsonResponse(body)).verify({ token }), code);
  });

  it('rejects malformed, oversized, non-success, and failed fetches safely', async () => {
    await expectSafeError(
      () => verifier(async () => new Response('{broken')).verify({ token }),
      'TURNSTILE_UNAVAILABLE',
      '{broken',
    );
    await expectSafeError(
      () => verifier(async () => new Response(new Uint8Array(16_385))).verify({ token }),
      'TURNSTILE_UNAVAILABLE',
    );
    await expectSafeError(
      () => verifier(async () => new Response(null, { status: 503 })).verify({ token }),
      'TURNSTILE_UNAVAILABLE',
    );
    await expectSafeError(
      () =>
        verifier(async (_input, init) => {
          expect(init?.signal).toBeInstanceOf(AbortSignal);
          throw new Error(`timeout with ${token} and ${secret}`);
        }).verify({ token }),
      'TURNSTILE_UNAVAILABLE',
    );
  });

  it('rejects empty and oversized tokens before fetch', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expectSafeError(() => verifier(fetcher).verify({ token: ' ' }), 'TURNSTILE_INVALID', ' ');
    await expectSafeError(
      () => verifier(fetcher).verify({ token: 'x'.repeat(2_049) }),
      'TURNSTILE_INVALID',
      'x'.repeat(2_049),
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('verifyTurnstileOnce', () => {
  it('consumes a token before verification and rejects every replay', async () => {
    const replayRequests: unknown[] = [];
    const replays = replayNamespace(replayRequests);
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 503 }));
    const dependencies = {
      replays,
      secret,
      expectedHostname: 'threads.example',
      fetcher,
      now: () => now,
    };

    await expectSafeError(
      () => verifyTurnstileOnce({ token }, dependencies),
      'TURNSTILE_UNAVAILABLE',
    );
    await expectSafeError(() => verifyTurnstileOnce({ token }, dependencies), 'TURNSTILE_REPLAYED');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(replayRequests)).not.toContain(token);
    expect(Object.keys(replayRequests[0] as Record<string, unknown>).sort()).toEqual([
      'consumedAt',
      'expiresAt',
      'tokenHash',
    ]);
  });

  it('fails closed when replay storage throws or returns an unexpected status', async () => {
    const throwingReplays: TurnstileReplayNamespace = {
      idFromName() {
        throw new Error(`storage failure containing ${token}`);
      },
      get() {
        throw new Error('unreachable');
      },
    };
    await expectSafeError(
      () =>
        verifyTurnstileOnce(
          { token },
          {
            replays: throwingReplays,
            secret,
            expectedHostname: 'threads.example',
            now: () => now,
          },
        ),
      'TURNSTILE_UNAVAILABLE',
    );

    const unavailableReplays: TurnstileReplayNamespace = {
      idFromName() {
        return {} as DurableObjectId;
      },
      get() {
        return { fetch: async () => Response.json({ ok: false }, { status: 503 }) };
      },
    };
    await expectSafeError(
      () =>
        verifyTurnstileOnce(
          { token: `${token}-other` },
          {
            replays: unavailableReplays,
            secret,
            expectedHostname: 'threads.example',
            now: () => now,
          },
        ),
      'TURNSTILE_UNAVAILABLE',
    );
  });
});

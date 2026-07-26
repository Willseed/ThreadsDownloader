import { describe, expect, it, vi } from 'vitest';

import {
  reserveSessionIssuance,
  SessionIssuanceError,
  type SessionIssuanceRateLimitNamespace,
} from '../src/security/session-issuance.js';
import { importSigningKey } from '../src/security/cryptography.js';
import { SESSION_ISSUANCE_RESERVATION_MS } from '../src/security/session-issuance-rate-limit.js';

const signingKeyMaterial = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const clientIp = '203.0.113.42';
const now = 10_000;

interface ReservationRequestBody {
  readonly ipHash: string;
  readonly now: number;
  readonly reservationId: string;
}

function namespace(fetcher: (request: Request) => Promise<Response>): {
  readonly binding: SessionIssuanceRateLimitNamespace;
  readonly get: ReturnType<typeof vi.fn>;
  readonly paths: string[];
} {
  const paths: string[] = [];
  const fetch = vi.fn(async (request: Request) => {
    paths.push(new URL(request.url).pathname);
    return fetcher(request);
  });
  const get = vi.fn(() => ({ fetch }));
  return {
    binding: {
      idFromName: () => ({}) as DurableObjectId,
      get,
    },
    get,
    paths,
  };
}

async function reserve(
  ipRateLimits: SessionIssuanceRateLimitNamespace,
): ReturnType<typeof reserveSessionIssuance> {
  return reserveSessionIssuance({
    headers: new Headers({ 'CF-Connecting-IP': clientIp }),
    ipRateLimits,
    signingKey: await importSigningKey(signingKeyMaterial),
    now,
  });
}

async function createdReservationResponse(request: Request): Promise<Response> {
  const body = (await request.json()) as ReservationRequestBody;
  return Response.json(
    {
      ok: true,
      reservationId: body.reservationId,
      expiresAt: body.now + SESSION_ISSUANCE_RESERVATION_MS,
    },
    { status: 201 },
  );
}

describe('session issuance client', () => {
  it('strictly reserves, commits, and releases through the expected internal operations', async () => {
    const inputs: ReservationRequestBody[] = [];
    const limiter = namespace(async (request) => {
      const pathname = new URL(request.url).pathname;
      if (pathname === '/session-issuance/reserve') {
        const clone = request.clone();
        inputs.push((await clone.json()) as ReservationRequestBody);
        return createdReservationResponse(request);
      }
      inputs.push((await request.json()) as ReservationRequestBody);
      return Response.json({ ok: true });
    });
    const reservation = await reserve(limiter.binding);

    expect(reservation.expiresAt).toBe(now + SESSION_ISSUANCE_RESERVATION_MS);
    await expect(reservation.commit(now + 1)).resolves.toBeUndefined();
    await expect(reservation.release(now + 2)).resolves.toBe(true);
    expect(limiter.paths).toEqual([
      '/session-issuance/reserve',
      '/session-issuance/commit',
      '/session-issuance/release',
    ]);
    expect(inputs).toHaveLength(3);
    expect(inputs.every((input) => input.ipHash === inputs[0]?.ipHash)).toBe(true);
    expect(inputs.every((input) => input.reservationId === inputs[0]?.reservationId)).toBe(true);
    expect(JSON.stringify(inputs)).not.toContain(clientIp);
  });

  it('decodes an exact 429 and rejects non-exact reservation responses', async () => {
    const retryAt = now + 120_001;
    const limited = namespace(async () => Response.json({ ok: false, retryAt }, { status: 429 }));
    await expect(reserve(limited.binding)).rejects.toEqual(
      expect.objectContaining<Partial<SessionIssuanceError>>({
        code: 'SESSION_ISSUANCE_RATE_LIMITED',
        retryAt,
      }),
    );

    const malformedResponses = [
      async (request: Request) => {
        const body = (await request.json()) as ReservationRequestBody;
        return Response.json(
          {
            ok: true,
            reservationId: body.reservationId,
            expiresAt: body.now + SESSION_ISSUANCE_RESERVATION_MS,
            extra: true,
          },
          { status: 201 },
        );
      },
      async () => Response.json({ ok: false, retryAt, extra: true }, { status: 429 }),
      async () => Response.json({ ok: false, retryAt: now }, { status: 429 }),
    ];
    for (const fetcher of malformedResponses) {
      await expect(reserve(namespace(fetcher).binding)).rejects.toEqual(
        expect.objectContaining<Partial<SessionIssuanceError>>({
          code: 'SESSION_ISSUANCE_UNAVAILABLE',
        }),
      );
    }
  });

  it('fails closed when mutation responses are lost, malformed, or non-successful', async () => {
    let mutationAttempt = 0;
    const limiter = namespace(async (request) => {
      if (new URL(request.url).pathname === '/session-issuance/reserve') {
        return createdReservationResponse(request);
      }
      mutationAttempt += 1;
      if (mutationAttempt === 1) {
        throw new Error('lost response');
      }
      if (mutationAttempt === 2) {
        return new Response('{', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return Response.json({ ok: true }, { status: 503 });
    });
    const reservation = await reserve(limiter.binding);

    await expect(reservation.commit(now + 1)).rejects.toEqual(
      expect.objectContaining<Partial<SessionIssuanceError>>({
        code: 'SESSION_ISSUANCE_UNAVAILABLE',
      }),
    );
    await expect(reservation.release(now + 2)).resolves.toBe(false);
    await expect(reservation.commit(now + 3)).rejects.toEqual(
      expect.objectContaining<Partial<SessionIssuanceError>>({
        code: 'SESSION_ISSUANCE_UNAVAILABLE',
      }),
    );
  });

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

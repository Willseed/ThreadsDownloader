import { describe, expect, it } from 'vitest';

import {
  acquireRateLimitPermit,
  acquireResolvePermit,
  hydrateRateLimitState,
  IP_RESOLVE_POLICY,
  nextRateLimitDeadline,
  nextResolvePermitDeadline,
  pruneResolveRateLimit,
  releaseRateLimitPermit,
  releaseResolvePermit,
  ResolveRateLimitError,
  type ResolveRateLimitState,
} from '../src/security/rate-limit.js';
import {
  acquireSessionResolvePermit,
  releaseSessionResolvePermit,
  type SessionNamespace,
} from '../src/security/session-client.js';
import { decodeBase64Url } from '../src/utils/base64url.js';

const permitIds = Array.from({ length: 8 }, (_, index) =>
  btoa(`permit-${index}`.padEnd(16, '-')).replaceAll('=', ''),
);
const empty: ResolveRateLimitState = { events: [], permits: [] };

function expectRateError(action: () => unknown, code: string): void {
  expect(action).toThrowError(ResolveRateLimitError);
  try {
    action();
  } catch (error) {
    expect((error as ResolveRateLimitError).code).toBe(code);
  }
}

describe('resolve rate-limit state', () => {
  it('hydrates SQLite rows in input order without mutating or aliasing inputs', () => {
    const eventRows = [{ event_at: 30 }, { event_at: 10 }];
    const permitRows = [
      { permit_id: permitIds[1]!, expires_at: 90 },
      { permit_id: permitIds[0]!, expires_at: 40 },
    ];
    const inputs = { eventRows, permitRows };
    const before = structuredClone(inputs);

    const state = hydrateRateLimitState(eventRows, permitRows);

    expect(state).toEqual({
      events: [30, 10],
      permits: [
        { id: permitIds[1], expiresAt: 90 },
        { id: permitIds[0], expiresAt: 40 },
      ],
    });
    expect(state.events).not.toBe(eventRows);
    expect(state.permits).not.toBe(permitRows);
    expect(state.permits[0]).not.toBe(permitRows[0]);
    expect(inputs).toEqual(before);
  });

  it('admits five released attempts and denies the sixth without mutating state', () => {
    let state = empty;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      state = acquireResolvePermit(state, attempt, permitIds[attempt]!);
      state = releaseResolvePermit(state, attempt, permitIds[attempt]!);
    }
    const before = structuredClone(state);
    expectRateError(() => acquireResolvePermit(state, 5, permitIds[5]!), 'RESOLVE_WINDOW_LIMIT');
    expect(state).toEqual(before);
  });

  it('expires an event at exactly the sixty-second boundary', () => {
    const state = { events: [1_000], permits: [] };
    expect(pruneResolveRateLimit(state, 60_999).events).toEqual([1_000]);
    expect(pruneResolveRateLimit(state, 61_000).events).toEqual([]);
  });

  it('denies a concurrent permit until release', () => {
    const admitted = acquireResolvePermit(empty, 100, permitIds[0]!);
    expectRateError(
      () => acquireResolvePermit(admitted, 101, permitIds[1]!),
      'RESOLVE_CONCURRENT_LIMIT',
    );
    expect(
      acquireResolvePermit(releaseResolvePermit(admitted, 102, permitIds[0]!), 103, permitIds[1]!)
        .permits,
    ).toHaveLength(1);
  });

  it('cleans an expired lease and reports the earliest active deadline', () => {
    const first = acquireResolvePermit(empty, 10, permitIds[0]!);
    expect(nextResolvePermitDeadline(first)).toBe(60_010);
    expect(pruneResolveRateLimit(first, 60_009).permits).toHaveLength(1);
    expect(pruneResolveRateLimit(first, 60_010).permits).toEqual([]);
  });

  it('releasing a missing valid permit is idempotent and immutable', () => {
    const state = { events: [10], permits: [] };
    expect(releaseResolvePermit(state, 11, permitIds[0]!)).toEqual(state);
    expect(state).toEqual({ events: [10], permits: [] });
  });

  it.each([
    [() => acquireResolvePermit(empty, -1, permitIds[0]!)],
    [() => acquireResolvePermit(empty, Number.MAX_SAFE_INTEGER + 1, permitIds[0]!)],
    [() => acquireResolvePermit(empty, 1, 'short')],
    [() => releaseResolvePermit(empty, 1, 'not!base64url')],
    [() => pruneResolveRateLimit({ events: [-1], permits: [] }, 1)],
  ])('rejects unsafe times, IDs, and stored state', (action) => {
    expectRateError(action, 'RESOLVE_RATE_INVALID');
  });
});

describe('IP resolve rate-limit policy', () => {
  it('tracks the earliest lease or sliding-window expiry across three concurrent permits', () => {
    let state: ResolveRateLimitState = empty;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      state = acquireRateLimitPermit(state, 100 + attempt, permitIds[attempt]!, IP_RESOLVE_POLICY);
    }
    expect(nextRateLimitDeadline(state, IP_RESOLVE_POLICY)).toBe(60_100);
    expectRateError(
      () => acquireRateLimitPermit(state, 104, permitIds[3]!, IP_RESOLVE_POLICY),
      'RESOLVE_CONCURRENT_LIMIT',
    );
    state = releaseRateLimitPermit(state, 105, permitIds[0]!, IP_RESOLVE_POLICY);
    expect(
      acquireRateLimitPermit(state, 106, permitIds[3]!, IP_RESOLVE_POLICY).permits,
    ).toHaveLength(3);
  });
});

describe('session resolve permit helpers', () => {
  function namespace(
    requests: unknown[],
    acquireStatus = 201,
    releaseStatus = 200,
  ): SessionNamespace {
    return {
      idFromName() {
        return {} as DurableObjectId;
      },
      get() {
        return {
          async fetch(request) {
            const body: unknown = await request.json();
            requests.push(body);
            const release = new URL(request.url).pathname.endsWith('/release');
            expect(request.method).toBe('POST');
            expect(new URL(request.url).pathname).toBe(
              release ? '/resolve-permits/release' : '/resolve-permits/acquire',
            );
            return release
              ? Response.json({ ok: releaseStatus === 200 }, { status: releaseStatus })
              : Response.json(
                  { ok: acquireStatus === 201, expiresAt: 30_100 },
                  { status: acquireStatus },
                );
          },
        };
      },
    };
  }

  function failureNamespace(fetchResponse: () => Response): SessionNamespace {
    return {
      idFromName() {
        return {} as DurableObjectId;
      },
      get() {
        return {
          async fetch() {
            return fetchResponse();
          },
        };
      },
    };
  }

  it('creates an opaque permit and sends only hashes and timestamps internally', async () => {
    const requests: unknown[] = [];
    const identity = { rawId: 'raw-session-id', sessionHash: 'A'.repeat(43) };
    const permit = await acquireSessionResolvePermit(
      namespace(requests),
      identity,
      'B'.repeat(43),
      100,
    );
    expect(decodeBase64Url(permit.permitId).byteLength).toBeGreaterThanOrEqual(16);
    expect(permit.expiresAt).toBe(30_100);
    expect(JSON.stringify(requests)).not.toContain(identity.rawId);
    expect(Object.keys(requests[0] as Record<string, unknown>).sort()).toEqual([
      'csrfHash',
      'now',
      'permitId',
      'sessionHash',
    ]);
  });

  it('returns a safe typed denial and releases idempotently', async () => {
    const identity = { rawId: 'internal-only', sessionHash: 'A'.repeat(43) };
    await expect(
      acquireSessionResolvePermit(namespace([], 429), identity, 'B'.repeat(43), 100),
    ).rejects.toMatchObject({ code: 'RESOLVE_PERMIT_DENIED' });
    await expect(
      acquireSessionResolvePermit(namespace([], 401), identity, 'B'.repeat(43), 100),
    ).rejects.toMatchObject({
      code: 'SESSION_INVALID',
      message: 'SESSION_INVALID',
      name: 'SessionResolvePermitError',
    });
    const releaseRequests: unknown[] = [];
    await expect(
      releaseSessionResolvePermit(namespace(releaseRequests), identity, permitIds[0]!, 100),
    ).resolves.toBe(true);
    expect(releaseRequests).toEqual([
      { sessionHash: identity.sessionHash, permitId: permitIds[0], now: 100 },
    ]);
    expect(JSON.stringify(releaseRequests)).not.toContain(identity.rawId);
    await expect(
      releaseSessionResolvePermit(namespace([], 201, 500), identity, permitIds[0]!, 100),
    ).resolves.toBe(false);
  });

  it.each([
    ['a non-special status', () => new Response('private status detail', { status: 503 })],
    [
      'a transport failure',
      () => {
        throw new Error('private transport detail');
      },
    ],
    ['malformed JSON', () => new Response('{private malformed detail', { status: 201 })],
    ['an expired permit', () => Response.json({ ok: true, expiresAt: 100 }, { status: 201 })],
  ])('maps %s to a safe unavailable error', async (_case, fetchResponse) => {
    const identity = { rawId: 'private-routing-id', sessionHash: 'A'.repeat(43) };
    const error: unknown = await acquireSessionResolvePermit(
      failureNamespace(fetchResponse),
      identity,
      'B'.repeat(43),
      100,
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'RESOLVE_PERMIT_UNAVAILABLE',
      message: 'RESOLVE_PERMIT_UNAVAILABLE',
      name: 'SessionResolvePermitError',
    });
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain('private');
  });
});

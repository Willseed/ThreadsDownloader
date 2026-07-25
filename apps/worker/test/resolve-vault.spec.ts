import { describe, expect, it, vi } from 'vitest';

import type { ProbedMedia } from '../src/resolver/media-probe.js';
import {
  claimResolvedMediaCandidate,
  decodeProbedMediaWire,
  decodeResolveVaultClaimRequest,
  decodeResolveVaultSettleRequest,
  decodeResolveVaultStoreRequest,
  deriveResolvedMediaFilename,
  encodeProbedMediaWire,
  RESOLVE_VAULT_RESERVATION_MS,
  RESOLVE_VAULT_TTL_MS,
  ResolveVaultError,
  settleResolvedMediaClaim,
  storeResolvedMediaBatch,
  type ResolveVaultErrorCode,
} from '../src/security/resolve-vault.js';
import type { SessionNamespace } from '../src/security/session-client.js';
import { parseCdnUrl } from '../src/security/upstream-policy.js';
import { decodeBase64Url, encodeBase64Url } from '../src/utils/base64url.js';

const NOW = 1_000_000;
const PRIVATE_URL = 'https://video.cdninstagram.com/media/private.mp4?token=private-vault-url';
const LAST_MODIFIED = 'Mon, 01 Jan 2024 00:00:00 GMT';

function bytes(length: number, offset = 0): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index + offset) % 256);
}

const sessionHash = encodeBase64Url(bytes(32, 1));
const csrfHash = encodeBase64Url(bytes(32, 2));
const permitId = encodeBase64Url(bytes(24, 3));
const resolveId = encodeBase64Url(bytes(24, 4));
const candidateId = encodeBase64Url(bytes(24, 5));
const reservationId = encodeBase64Url(bytes(24, 6));
const identity = { rawId: 'private-raw-session-id', sessionHash };

function media(overrides: Partial<ProbedMedia> = {}): ProbedMedia {
  return {
    finalUrl: parseCdnUrl(PRIVATE_URL),
    contentType: 'video/mp4',
    contentLength: 42,
    rangeCapability: 'bytes',
    strongEtag: '"strong-v1"',
    lastModified: LAST_MODIFIED,
    validator: { kind: 'etag', value: '"strong-v1"' },
    completionReliable: true,
    probeMethod: 'head',
    ...overrides,
  };
}

function storeBody(count = 1): Record<string, unknown> {
  return {
    sessionHash,
    csrfHash,
    permitId,
    now: NOW,
    shortcode: 'Abcde_1',
    candidates: Array.from({ length: count }, (_, index) =>
      encodeProbedMediaWire(
        media(index === 0 ? {} : { contentLength: null, completionReliable: false }),
      ),
    ),
  };
}

function claimBody(): Record<string, unknown> {
  return { sessionHash, csrfHash, now: NOW, resolveId, candidateId, reservationId };
}

async function expectVaultError(
  action: Promise<unknown>,
  code: ResolveVaultErrorCode,
  secrets: readonly string[] = [],
): Promise<void> {
  let caught: unknown;
  try {
    await action;
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ResolveVaultError);
  expect(caught).toMatchObject({ code, message: code });
  for (const secret of secrets) {
    expect((caught as Error).message).not.toContain(secret);
  }
}

function namespace(
  handler: (request: Request) => Promise<Response>,
  names: string[] = [],
): SessionNamespace {
  return {
    idFromName(name) {
      names.push(name);
      return {} as DurableObjectId;
    },
    get() {
      return { fetch: handler };
    },
  };
}

describe('resolved media vault wire', () => {
  it('round-trips only the strict serializable ProbedMedia shape', () => {
    const wire = encodeProbedMediaWire(media());
    expect(wire).toEqual({
      finalUrl: PRIVATE_URL,
      contentType: 'video/mp4',
      contentLength: 42,
      rangeCapability: 'bytes',
      strongEtag: '"strong-v1"',
      lastModified: LAST_MODIFIED,
      completionReliable: true,
      probeMethod: 'head',
    });
    expect(decodeProbedMediaWire(wire)).toEqual(media());
    expect(decodeProbedMediaWire({ ...wire, rawCookie: 'private' })).toBeNull();
    expect(
      decodeProbedMediaWire({ ...wire, finalUrl: 'https://attacker.example/private' }),
    ).toBeNull();
  });

  it.each([
    ['video/mp4', 'mp4'],
    ['video/webm', 'webm'],
    ['video/quicktime', 'mov'],
    ['video/x-m4v', 'm4v'],
    ['video/x-private', 'video'],
  ])('derives a safe %s filename without using the upstream path', (contentType, extension) => {
    expect(deriveResolvedMediaFilename('Abcde_1', 2, contentType)).toBe(
      `threads_Abcde_1_2.${extension}`,
    );
  });

  it('rejects unsafe shortcode and ordinal inputs with a fixed error', () => {
    expect(() => deriveResolvedMediaFilename('../private', 1, 'video/mp4')).toThrowError(
      ResolveVaultError,
    );
    expect(() => deriveResolvedMediaFilename('Abcde', 11, 'video/mp4')).toThrowError(
      ResolveVaultError,
    );
  });
});

describe('resolve vault exact request decoders', () => {
  it('accepts one through ten candidates and rejects zero, eleven, or extra fields', () => {
    expect(decodeResolveVaultStoreRequest(storeBody(1))?.candidates).toHaveLength(1);
    expect(decodeResolveVaultStoreRequest(storeBody(10))?.candidates).toHaveLength(10);
    expect(decodeResolveVaultStoreRequest(storeBody(0))).toBeNull();
    expect(decodeResolveVaultStoreRequest(storeBody(11))).toBeNull();
    expect(decodeResolveVaultStoreRequest({ ...storeBody(), rawId: identity.rawId })).toBeNull();
    expect(decodeResolveVaultStoreRequest({ ...storeBody(), permitId: 'short' })).toBeNull();
  });

  it('requires canonical 192-bit public and reservation IDs', () => {
    expect(decodeResolveVaultClaimRequest(claimBody())).toEqual(claimBody());
    expect(
      decodeResolveVaultClaimRequest({ ...claimBody(), candidateId: permitId.slice(0, 22) }),
    ).toBeNull();
    expect(decodeResolveVaultClaimRequest({ ...claimBody(), extra: 'private' })).toBeNull();
  });

  it('decodes settle only with an exact outcome-bearing shape', () => {
    expect(decodeResolveVaultSettleRequest({ ...claimBody(), outcome: 'consume' })).toEqual({
      ...claimBody(),
      outcome: 'consume',
    });
    expect(decodeResolveVaultSettleRequest({ ...claimBody(), outcome: 'private' })).toBeNull();
    expect(decodeResolveVaultSettleRequest(claimBody())).toBeNull();
  });
});

describe('resolve vault session client', () => {
  it('stores a batch and exposes only safe optional public metadata', async () => {
    const requests: Request[] = [];
    const names: string[] = [];
    const sessions = namespace(async (request) => {
      requests.push(request);
      return Response.json(
        {
          ok: true,
          resolveId,
          issuedAt: NOW,
          expiresAt: NOW + 300_000,
          candidates: [
            { candidateId, filename: 'threads_Abcde_1_1.mp4', contentLength: 42 },
            {
              candidateId: encodeBase64Url(bytes(24, 7)),
              filename: 'threads_Abcde_1_2.webm',
            },
          ],
        },
        { status: 201 },
      );
    }, names);

    const result = await storeResolvedMediaBatch({
      sessions,
      identity,
      csrfHash,
      permitId,
      shortcode: 'Abcde_1',
      candidates: [
        media(),
        media({ contentType: 'video/webm', contentLength: null, completionReliable: false }),
      ],
      now: NOW,
      clock: () => NOW,
    });

    expect(result.candidates).toEqual([
      { candidateId, filename: 'threads_Abcde_1_1.mp4', contentLength: 42 },
      {
        candidateId: encodeBase64Url(bytes(24, 7)),
        filename: 'threads_Abcde_1_2.webm',
      },
    ]);
    expect(names).toEqual([identity.rawId]);
    const request = requests[0]!;
    expect(new URL(request.url).pathname).toBe('/resolve-vault/store');
    const body = (await request.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ sessionHash, csrfHash, permitId, now: NOW, shortcode: 'Abcde_1' });
    expect(JSON.stringify(body)).not.toContain(identity.rawId);
    expect(JSON.stringify(result)).not.toContain(PRIVATE_URL);
    expect(Object.keys(result.candidates[1]!)).not.toContain('contentLength');
    expect(Object.keys(result.candidates[0]!)).not.toEqual(
      expect.arrayContaining(['duration', 'height', 'width']),
    );
  });

  it('claims with a fresh 192-bit reservation and strictly decodes the internal media grant', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const sessions = namespace(async (request) => {
      requestBody = (await request.json()) as Record<string, unknown>;
      return Response.json({
        ok: true,
        reservationId: requestBody['reservationId'],
        reservedAt: NOW,
        reservationExpiresAt: NOW + 30_000,
        grant: encodeProbedMediaWire(media()),
      });
    });

    const claim = await claimResolvedMediaCandidate({
      sessions,
      identity,
      csrfHash,
      resolveId,
      candidateId,
      now: NOW,
      clock: () => NOW,
    });

    expect(decodeBase64Url(claim.reservationId)).toHaveLength(24);
    expect(claim.media).toEqual(media());
    expect(requestBody).toMatchObject({ sessionHash, csrfHash, resolveId, candidateId, now: NOW });
    expect(JSON.stringify(claim)).toContain(PRIVATE_URL);
  });

  it('retries one ambiguous claim transport failure with the same reservation ID', async () => {
    const reservationIds: unknown[] = [];
    let attempts = 0;
    const sessions = namespace(async (request) => {
      attempts += 1;
      const body = (await request.json()) as Record<string, unknown>;
      reservationIds.push(body['reservationId']);
      if (attempts === 1) {
        throw new Error('ambiguous transport failure');
      }
      return Response.json({
        ok: true,
        reservationId: body['reservationId'],
        reservedAt: NOW,
        reservationExpiresAt: NOW + 30_000,
        grant: encodeProbedMediaWire(media()),
      });
    });

    await expect(
      claimResolvedMediaCandidate({
        sessions,
        identity,
        csrfHash,
        resolveId,
        candidateId,
        now: NOW,
        clock: () => NOW,
      }),
    ).resolves.toMatchObject({ media: media() });
    expect(reservationIds).toHaveLength(2);
    expect(reservationIds[0]).toBe(reservationIds[1]);
  });

  it('accepts exact server-relative TTLs when the object clock advances after the request', async () => {
    const serverNow = NOW + 10;
    const receivedAt = NOW + 20;
    const storeSessions = namespace(async () =>
      Response.json(
        {
          ok: true,
          resolveId,
          issuedAt: serverNow,
          expiresAt: serverNow + RESOLVE_VAULT_TTL_MS,
          candidates: [{ candidateId, filename: 'threads_Abcde_1_1.mp4', contentLength: 42 }],
        },
        { status: 201 },
      ),
    );

    await expect(
      storeResolvedMediaBatch({
        sessions: storeSessions,
        identity,
        csrfHash,
        permitId,
        shortcode: 'Abcde_1',
        candidates: [media()],
        now: NOW,
        clock: () => receivedAt,
      }),
    ).resolves.toMatchObject({ expiresAt: serverNow + RESOLVE_VAULT_TTL_MS });

    const claimSessions = namespace(async (request) => {
      const body = (await request.json()) as Record<string, unknown>;
      return Response.json({
        ok: true,
        reservationId: body['reservationId'],
        reservedAt: serverNow,
        reservationExpiresAt: serverNow + RESOLVE_VAULT_RESERVATION_MS,
        grant: encodeProbedMediaWire(media()),
      });
    });
    await expect(
      claimResolvedMediaCandidate({
        sessions: claimSessions,
        identity,
        csrfHash,
        resolveId,
        candidateId,
        now: NOW,
        clock: () => receivedAt,
      }),
    ).resolves.toMatchObject({
      reservationExpiresAt: serverNow + RESOLVE_VAULT_RESERVATION_MS,
    });
  });

  it('best-effort releases malformed claim success and enforces response TTL bounds', async () => {
    const requests: { readonly path: string; readonly body: Record<string, unknown> }[] = [];
    const sessions = namespace(async (request) => {
      const body = (await request.json()) as Record<string, unknown>;
      requests.push({ path: new URL(request.url).pathname, body });
      if (requests.length === 1) {
        return Response.json({
          ok: true,
          reservationId: body['reservationId'],
          reservedAt: NOW,
          reservationExpiresAt: NOW + RESOLVE_VAULT_RESERVATION_MS + 1,
          grant: encodeProbedMediaWire(media()),
        });
      }
      return Response.json({ ok: true });
    });
    await expectVaultError(
      claimResolvedMediaCandidate({
        sessions,
        identity,
        csrfHash,
        resolveId,
        candidateId,
        now: NOW,
        clock: () => NOW,
      }),
      'RESOLVE_VAULT_UNAVAILABLE',
    );
    expect(requests.map(({ path }) => path)).toEqual([
      '/resolve-vault/claim',
      '/resolve-vault/settle',
    ]);
    expect(requests[1]!.body).toMatchObject({
      reservationId: requests[0]!.body['reservationId'],
      outcome: 'release',
    });

    const overlongStore = namespace(async () =>
      Response.json(
        {
          ok: true,
          resolveId,
          issuedAt: NOW,
          expiresAt: NOW + RESOLVE_VAULT_TTL_MS + 1,
          candidates: [{ candidateId, filename: 'threads_Abcde_1_1.mp4' }],
        },
        { status: 201 },
      ),
    );
    await expectVaultError(
      storeResolvedMediaBatch({
        sessions: overlongStore,
        identity,
        csrfHash,
        permitId,
        shortcode: 'Abcde',
        candidates: [media()],
        now: NOW,
        clock: () => NOW,
      }),
      'RESOLVE_VAULT_UNAVAILABLE',
    );
  });

  it('maps reservation RNG failure to a fixed safe error', async () => {
    const random = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(() => {
      throw new Error('private RNG failure');
    });
    try {
      await expectVaultError(
        claimResolvedMediaCandidate({
          sessions: namespace(async () => Response.json({ ok: false }, { status: 500 })),
          identity,
          csrfHash,
          resolveId,
          candidateId,
          now: NOW,
        }),
        'RESOLVE_VAULT_UNAVAILABLE',
        ['private RNG failure'],
      );
    } finally {
      random.mockRestore();
    }
  });

  it('settles with CSRF and maps every internal denial to a fixed safe error', async () => {
    const requests: unknown[] = [];
    const sessions = namespace(async (request) => {
      requests.push(await request.json());
      return Response.json({ ok: true });
    });
    await settleResolvedMediaClaim({
      sessions,
      identity,
      csrfHash,
      resolveId,
      candidateId,
      reservationId,
      outcome: 'consume',
      now: NOW,
    });
    expect(requests).toEqual([
      {
        sessionHash,
        csrfHash,
        now: NOW,
        resolveId,
        candidateId,
        reservationId,
        outcome: 'consume',
      },
    ]);

    for (const [status, code] of [
      [400, 'RESOLVE_VAULT_INVALID'],
      [401, 'SESSION_INVALID'],
      [404, 'RESOLVE_VAULT_NOT_FOUND'],
      [409, 'RESOLVE_VAULT_CONFLICT'],
      [429, 'RESOLVE_VAULT_CAPACITY'],
      [500, 'RESOLVE_VAULT_UNAVAILABLE'],
    ] as const) {
      const denied = namespace(async () => Response.json({ detail: PRIVATE_URL }, { status }));
      await expectVaultError(
        claimResolvedMediaCandidate({
          sessions: denied,
          identity,
          csrfHash,
          resolveId,
          candidateId,
          now: NOW,
        }),
        code,
        [PRIVATE_URL, identity.rawId],
      );
    }
  });

  it('maps transport and malformed success responses without leaking details', async () => {
    const secret = 'private transport and URL detail';
    const unavailable = namespace(async () => {
      throw new Error(secret);
    });
    await expectVaultError(
      storeResolvedMediaBatch({
        sessions: unavailable,
        identity,
        csrfHash,
        permitId,
        shortcode: 'Abcde',
        candidates: [media()],
        now: NOW,
      }),
      'RESOLVE_VAULT_UNAVAILABLE',
      [secret, PRIVATE_URL],
    );

    const malformed = namespace(async () => Response.json({ ok: true }, { status: 201 }));
    await expectVaultError(
      storeResolvedMediaBatch({
        sessions: malformed,
        identity,
        csrfHash,
        permitId,
        shortcode: 'Abcde',
        candidates: [media()],
        now: NOW,
      }),
      'RESOLVE_VAULT_UNAVAILABLE',
    );
  });
});

import { describe, expect, it, vi } from 'vitest';

import { createUnverifiedMedia, type ProbedMedia } from '../src/resolver/media-probe.js';
import {
  DOWNLOAD_SESSION_CLIENT_REQUEST_TIMEOUT_MS,
  DownloadSessionClientError,
  type DownloadSessionNamespace,
} from '../src/security/download-session-client.js';
import {
  RESOLVE_VAULT_REQUEST_TIMEOUT_MS,
  ResolveVaultError,
  type ResolvedMediaClaim,
} from '../src/security/resolve-vault.js';
import { parseCdnUrl } from '../src/security/upstream-policy.js';
import type { SessionNamespace } from '../src/security/session-client.js';
import { encodeBase64Url } from '../src/utils/base64url.js';
import {
  createDownloadSessionIssuer,
  createRemoteDownloadSessionIssuer,
  DOWNLOAD_SESSION_ISSUANCE_CLAIM_TIMEOUT_MS,
  DOWNLOAD_SESSION_ISSUANCE_DESTROY_TIMEOUT_MS,
  DOWNLOAD_SESSION_ISSUANCE_INITIALIZE_TIMEOUT_MS,
  DOWNLOAD_SESSION_ISSUANCE_SETTLE_TIMEOUT_MS,
  DownloadSessionIssuanceError,
  type DownloadSessionIssuancePort,
  type IssueDownloadSessionInput,
  type ResolvedMediaIssuancePort,
} from '../src/workflows/issue-download-session.js';

const PRIVATE_URL = 'https://video.cdninstagram.com/private.mp4?token=issuance-secret';
const NOW = 1_000_000;

function bytes(length: number, offset: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (offset + index) % 256);
}

const identity = {
  rawId: encodeBase64Url(bytes(32, 1)),
  sessionHash: encodeBase64Url(bytes(32, 2)),
};
const csrfHash = encodeBase64Url(bytes(32, 3));
const resolveId = encodeBase64Url(bytes(24, 4));
const candidateId = encodeBase64Url(bytes(24, 5));
const reservationId = encodeBase64Url(bytes(24, 6));
const downloadId = encodeBase64Url(bytes(24, 7));

const input: IssueDownloadSessionInput = { identity, csrfHash, resolveId, candidateId };

function media(): ProbedMedia {
  return {
    finalUrl: parseCdnUrl(PRIVATE_URL),
    contentType: 'video/mp4',
    contentLength: 1_024,
    rangeCapability: 'bytes',
    strongEtag: '"issuance-etag"',
    lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
    validator: { kind: 'etag', value: '"issuance-etag"' },
    completionReliable: true,
    probeMethod: 'head',
  };
}

function claim(): ResolvedMediaClaim {
  return {
    reservationId,
    reservationExpiresAt: NOW + 30_000,
    filename: 'threads_Authority_1.mp4',
    shortcode: 'Authority',
    media: media(),
  };
}

function initialized() {
  return {
    downloadId,
    issuedAt: NOW,
    startExpiresAt: NOW + 120_000,
    absoluteExpiresAt: NOW + 3_600_000,
  };
}

function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

function hangingJsonResponse(status: number): Response {
  return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function durableNamespace(
  handler: (request: Request) => Promise<Response>,
  names: string[] = [],
): SessionNamespace & DownloadSessionNamespace {
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

function remoteClaimResponse(body: Record<string, unknown>): Response {
  const requestedAt = body['now'] as number;
  return Response.json({
    ok: true,
    reservationId: body['reservationId'],
    reservedAt: requestedAt,
    reservationExpiresAt: requestedAt + 30_000,
    filename: 'threads_Authority_1.mp4',
    shortcode: 'Authority',
    grant: {
      finalUrl: PRIVATE_URL,
      contentType: 'video/mp4',
      contentLength: 1_024,
      rangeCapability: 'bytes',
      strongEtag: '"issuance-etag"',
      lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
      completionReliable: true,
      probeMethod: 'head',
    },
  });
}

function remoteInitializeResponse(): Response {
  return Response.json(
    {
      ok: true,
      issuedAt: NOW,
      startExpiresAt: NOW + 120_000,
      absoluteExpiresAt: NOW + 3_600_000,
    },
    { status: 201 },
  );
}

function ports(
  overrides: {
    readonly claim?: ResolvedMediaIssuancePort['claim'];
    readonly settle?: ResolvedMediaIssuancePort['settle'];
    readonly initialize?: DownloadSessionIssuancePort['initialize'];
    readonly destroy?: DownloadSessionIssuancePort['destroy'];
  } = {},
): {
  readonly resolvedMedia: ResolvedMediaIssuancePort;
  readonly downloadSessions: DownloadSessionIssuancePort;
} {
  return {
    resolvedMedia: {
      claim: overrides.claim ?? vi.fn(async () => claim()),
      settle: overrides.settle ?? vi.fn(async () => undefined),
    },
    downloadSessions: {
      initialize: overrides.initialize ?? vi.fn(async () => initialized()),
      destroy: overrides.destroy ?? vi.fn(async () => undefined),
    },
  };
}

async function expectIssueError(
  action: Promise<unknown>,
  code: DownloadSessionIssuanceError['code'],
  secrets: readonly string[] = [],
): Promise<void> {
  let caught: unknown;
  try {
    await action;
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DownloadSessionIssuanceError);
  expect(caught).toMatchObject({ code, message: code });
  for (const secret of secrets) {
    expect((caught as Error).message).not.toContain(secret);
  }
}

describe('browser-bound download-session issuer', () => {
  it('publishes only after claim, authoritative initialization, and strict consumption', async () => {
    const events: string[] = [];
    const dependencies = ports({
      claim: vi.fn(async (actual) => {
        events.push('claim');
        expect(actual).toEqual(input);
        return claim();
      }),
      initialize: vi.fn(async (actual) => {
        events.push('initialize');
        expect(actual).toEqual({
          sessionHash: identity.sessionHash,
          filename: 'threads_Authority_1.mp4',
          shortcode: 'Authority',
          media: media(),
        });
        return initialized();
      }),
      settle: vi.fn(async (actual) => {
        events.push(actual.outcome);
        expect(actual).toEqual({ ...input, reservationId, outcome: 'consume' });
      }),
      destroy: vi.fn(async () => {
        events.push('destroy');
      }),
    });

    const result = await createDownloadSessionIssuer(dependencies).issue(input);
    expect(result).toEqual({
      downloadId,
      startExpiresAt: NOW + 120_000,
    });
    expect(events).toEqual(['claim', 'initialize', 'consume']);
    expect(dependencies.downloadSessions.destroy).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(PRIVATE_URL);
  });

  it('initializes a download session from an unverified rendered grant without publishing its URL', async () => {
    const unverified = createUnverifiedMedia(parseCdnUrl(PRIVATE_URL));
    const dependencies = ports({
      claim: vi.fn(async () => ({ ...claim(), media: unverified })),
      initialize: vi.fn(async (actual) => {
        expect(actual.media).toEqual(unverified);
        return initialized();
      }),
    });

    const result = await createDownloadSessionIssuer(dependencies).issue(input);

    expect(result).toEqual({ downloadId, startExpiresAt: NOW + 120_000 });
    expect(JSON.stringify(result)).not.toContain(PRIVATE_URL);
  });

  it('rejects malformed identity and opaque bindings before crossing either port', async () => {
    const dependencies = ports();
    await expectIssueError(
      createDownloadSessionIssuer(dependencies).issue({ ...input, resolveId: 'not-canonical' }),
      'DOWNLOAD_ISSUANCE_REQUEST_INVALID',
    );
    await expectIssueError(
      createDownloadSessionIssuer(dependencies).issue({
        ...input,
        identity: { ...identity, rawId: 'not-canonical' },
      }),
      'DOWNLOAD_ISSUANCE_REQUEST_INVALID',
    );
    expect(dependencies.resolvedMedia.claim).not.toHaveBeenCalled();
    expect(dependencies.downloadSessions.initialize).not.toHaveBeenCalled();
  });

  it('releases the exact reservation when initialization fails', async () => {
    const events: string[] = [];
    const dependencies = ports({
      initialize: vi.fn(async () => {
        events.push('initialize');
        throw new DownloadSessionClientError('DOWNLOAD_SESSION_UNAVAILABLE', 503);
      }),
      settle: vi.fn(async (actual) => {
        events.push(actual.outcome);
        expect(actual).toEqual({ ...input, reservationId, outcome: 'release' });
      }),
      destroy: vi.fn(async () => {
        events.push('destroy');
      }),
    });

    await expectIssueError(
      createDownloadSessionIssuer(dependencies).issue(input),
      'DOWNLOAD_SESSION_UNAVAILABLE',
      [PRIVATE_URL, identity.rawId],
    );
    expect(events).toEqual(['initialize', 'release']);
    expect(dependencies.downloadSessions.destroy).not.toHaveBeenCalled();
  });

  it('retries one ambiguous consume with the same reservation and publishes after its ack', async () => {
    const settlements: unknown[] = [];
    const dependencies = ports({
      settle: vi.fn(async (actual) => {
        settlements.push(actual);
        if (settlements.length === 1) {
          throw new ResolveVaultError('RESOLVE_VAULT_UNAVAILABLE');
        }
      }),
    });

    await expect(createDownloadSessionIssuer(dependencies).issue(input)).resolves.toEqual({
      downloadId,
      startExpiresAt: NOW + 120_000,
    });
    expect(settlements).toEqual([
      { ...input, reservationId, outcome: 'consume' },
      { ...input, reservationId, outcome: 'consume' },
    ]);
    expect(dependencies.downloadSessions.destroy).not.toHaveBeenCalled();
  });

  it('destroys before releasing and never publishes after two ambiguous consume results', async () => {
    const events: string[] = [];
    let consumeAttempts = 0;
    const dependencies = ports({
      settle: vi.fn(async (actual) => {
        events.push(actual.outcome);
        if (actual.outcome === 'consume') {
          consumeAttempts += 1;
          throw new ResolveVaultError('RESOLVE_VAULT_UNAVAILABLE');
        }
      }),
      destroy: vi.fn(async (actual) => {
        events.push('destroy');
        expect(actual).toEqual({ downloadId, sessionHash: identity.sessionHash });
      }),
    });

    await expectIssueError(
      createDownloadSessionIssuer(dependencies).issue(input),
      'DOWNLOAD_SESSION_UNAVAILABLE',
      [PRIVATE_URL, identity.rawId, downloadId],
    );
    expect(consumeAttempts).toBe(2);
    expect(events).toEqual(['consume', 'consume', 'destroy', 'release']);
  });

  it('rolls back a definite consume denial without retrying it', async () => {
    const events: string[] = [];
    const dependencies = ports({
      settle: vi.fn(async (actual) => {
        events.push(actual.outcome);
        if (actual.outcome === 'consume') {
          throw new ResolveVaultError('RESOLVE_VAULT_CONFLICT');
        }
      }),
      destroy: vi.fn(async () => {
        events.push('destroy');
      }),
    });

    await expectIssueError(
      createDownloadSessionIssuer(dependencies).issue(input),
      'DOWNLOAD_CANDIDATE_UNAVAILABLE',
    );
    expect(events).toEqual(['consume', 'destroy', 'release']);
  });

  it('maps session ownership failures without exposing port details', async () => {
    const secret = `${PRIVATE_URL}:${identity.rawId}:${downloadId}`;
    const dependencies = ports({
      claim: vi.fn(async () => {
        throw new ResolveVaultError('SESSION_INVALID');
      }),
      initialize: vi.fn(async () => {
        throw new Error(secret);
      }),
    });
    await expectIssueError(
      createDownloadSessionIssuer(dependencies).issue(input),
      'SESSION_INVALID',
      [secret, PRIVATE_URL, identity.rawId, downloadId],
    );
    expect(dependencies.downloadSessions.initialize).not.toHaveBeenCalled();
  });

  it('bounds a never-settling claim before initialization', async () => {
    vi.useFakeTimers();
    try {
      const dependencies = ports({ claim: vi.fn(() => never<ResolvedMediaClaim>()) });
      const outcome = expectIssueError(
        createDownloadSessionIssuer(dependencies).issue(input),
        'DOWNLOAD_SESSION_UNAVAILABLE',
      );
      await vi.advanceTimersByTimeAsync(DOWNLOAD_SESSION_ISSUANCE_CLAIM_TIMEOUT_MS);
      await outcome;
      expect(dependencies.downloadSessions.initialize).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds a never-settling initialize and still releases its claim', async () => {
    vi.useFakeTimers();
    try {
      const dependencies = ports({
        initialize: vi.fn(() => never<ReturnType<typeof initialized>>()),
      });
      const outcome = expectIssueError(
        createDownloadSessionIssuer(dependencies).issue(input),
        'DOWNLOAD_SESSION_UNAVAILABLE',
      );
      await vi.advanceTimersByTimeAsync(DOWNLOAD_SESSION_ISSUANCE_INITIALIZE_TIMEOUT_MS);
      await outcome;
      expect(dependencies.resolvedMedia.settle).toHaveBeenCalledWith({
        ...input,
        reservationId,
        outcome: 'release',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds two never-settling consume attempts before rollback', async () => {
    vi.useFakeTimers();
    try {
      const settlements: string[] = [];
      const dependencies = ports({
        settle: vi.fn((actual) => {
          settlements.push(actual.outcome);
          return actual.outcome === 'consume' ? never<void>() : Promise.resolve();
        }),
      });
      const outcome = expectIssueError(
        createDownloadSessionIssuer(dependencies).issue(input),
        'DOWNLOAD_SESSION_UNAVAILABLE',
      );
      await vi.advanceTimersByTimeAsync(DOWNLOAD_SESSION_ISSUANCE_SETTLE_TIMEOUT_MS * 2);
      await outcome;
      expect(settlements).toEqual(['consume', 'consume', 'release']);
      expect(dependencies.downloadSessions.destroy).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('continues from never-settling destroy through bounded release cleanup', async () => {
    vi.useFakeTimers();
    try {
      const settlements: string[] = [];
      const dependencies = ports({
        settle: vi.fn((actual) => {
          settlements.push(actual.outcome);
          return actual.outcome === 'consume'
            ? Promise.reject(new ResolveVaultError('RESOLVE_VAULT_CONFLICT'))
            : never<void>();
        }),
        destroy: vi.fn(() => never<void>()),
      });
      const outcome = expectIssueError(
        createDownloadSessionIssuer(dependencies).issue(input),
        'DOWNLOAD_CANDIDATE_UNAVAILABLE',
      );
      await vi.advanceTimersByTimeAsync(
        DOWNLOAD_SESSION_ISSUANCE_DESTROY_TIMEOUT_MS +
          DOWNLOAD_SESSION_ISSUANCE_SETTLE_TIMEOUT_MS * 2,
      );
      await outcome;
      expect(dependencies.downloadSessions.destroy).toHaveBeenCalledOnce();
      expect(settlements).toEqual(['consume', 'release', 'release']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('remote issuance adapters', () => {
  it('uses raw session ID only for routing and never returns the CDN target', async () => {
    const sessionNames: string[] = [];
    const sessionBodies: Record<string, unknown>[] = [];
    const downloadNames: string[] = [];
    const downloadBodies: Record<string, unknown>[] = [];
    const sessions = durableNamespace(async (request) => {
      const body = (await request.json()) as Record<string, unknown>;
      sessionBodies.push(body);
      return new URL(request.url).pathname === '/resolve-vault/claim'
        ? remoteClaimResponse(body)
        : Response.json({ ok: true });
    }, sessionNames);
    const downloadSessions = durableNamespace(async (request) => {
      downloadBodies.push((await request.json()) as Record<string, unknown>);
      return remoteInitializeResponse();
    }, downloadNames);

    const result = await createRemoteDownloadSessionIssuer({
      sessions,
      downloadSessions,
    }).issue(input);

    expect(sessionNames).toEqual([identity.rawId, identity.rawId]);
    expect(downloadNames).toEqual([result.downloadId]);
    expect(sessionBodies).toHaveLength(2);
    expect(downloadBodies).toHaveLength(1);
    expect(JSON.stringify(sessionBodies)).not.toContain(identity.rawId);
    expect(JSON.stringify(downloadBodies)).not.toContain(identity.rawId);
    expect(JSON.stringify(result)).not.toContain(PRIVATE_URL);
    expect(JSON.stringify(result)).not.toContain(identity.rawId);
    expect(JSON.stringify(result)).not.toContain('cookie');
  });

  it('allows owned initialize compensation to finish before the issuer deadline', async () => {
    vi.useFakeTimers();
    try {
      const sessionPaths: string[] = [];
      const downloadPaths: string[] = [];
      const sessions = durableNamespace(async (request) => {
        const path = new URL(request.url).pathname;
        sessionPaths.push(path);
        const body = (await request.json()) as Record<string, unknown>;
        return path === '/resolve-vault/claim'
          ? remoteClaimResponse(body)
          : Response.json({ ok: true });
      });
      const downloadSessions = durableNamespace((request) => {
        downloadPaths.push(new URL(request.url).pathname);
        return never();
      });
      const outcome = expectIssueError(
        createRemoteDownloadSessionIssuer({ sessions, downloadSessions }).issue(input),
        'DOWNLOAD_SESSION_UNAVAILABLE',
      );

      await vi.advanceTimersByTimeAsync(DOWNLOAD_SESSION_CLIENT_REQUEST_TIMEOUT_MS * 2);
      await outcome;
      expect(downloadPaths).toEqual(['/initialize', '/destroy']);
      expect(sessionPaths).toEqual(['/resolve-vault/claim', '/resolve-vault/settle']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for owned claim retry and compensation before its outer deadline', async () => {
    vi.useFakeTimers();
    try {
      const sessionPaths: string[] = [];
      const initialize = vi.fn(async () => Response.json({ ok: false }, { status: 500 }));
      const sessions = durableNamespace((request) => {
        sessionPaths.push(new URL(request.url).pathname);
        return never();
      });
      const outcome = expectIssueError(
        createRemoteDownloadSessionIssuer({
          sessions,
          downloadSessions: durableNamespace(initialize),
        }).issue(input),
        'DOWNLOAD_SESSION_UNAVAILABLE',
      );

      await vi.advanceTimersByTimeAsync(RESOLVE_VAULT_REQUEST_TIMEOUT_MS * 3);
      await outcome;
      expect(sessionPaths).toEqual([
        '/resolve-vault/claim',
        '/resolve-vault/claim',
        '/resolve-vault/settle',
      ]);
      expect(initialize).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for two owned consume timeouts before destroy and release', async () => {
    vi.useFakeTimers();
    try {
      const events: string[] = [];
      const sessions = durableNamespace(async (request) => {
        const path = new URL(request.url).pathname;
        const body = (await request.json()) as Record<string, unknown>;
        if (path === '/resolve-vault/claim') {
          events.push('claim');
          return remoteClaimResponse(body);
        }
        events.push(`settle:${String(body['outcome'])}`);
        return body['outcome'] === 'consume' ? never() : Response.json({ ok: true });
      });
      const downloadSessions = durableNamespace(async (request) => {
        const path = new URL(request.url).pathname;
        events.push(path === '/initialize' ? 'initialize' : 'destroy');
        return path === '/initialize' ? remoteInitializeResponse() : Response.json({ ok: true });
      });
      const outcome = expectIssueError(
        createRemoteDownloadSessionIssuer({ sessions, downloadSessions }).issue(input),
        'DOWNLOAD_SESSION_UNAVAILABLE',
      );

      await vi.advanceTimersByTimeAsync(RESOLVE_VAULT_REQUEST_TIMEOUT_MS * 2);
      await outcome;
      expect(events).toEqual([
        'claim',
        'initialize',
        'settle:consume',
        'settle:consume',
        'destroy',
        'settle:release',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('finishes owned destroy timeout before bounded release attempts', async () => {
    vi.useFakeTimers();
    try {
      const events: Array<readonly [string, number]> = [];
      const sessions = durableNamespace(async (request) => {
        const path = new URL(request.url).pathname;
        const body = (await request.json()) as Record<string, unknown>;
        if (path === '/resolve-vault/claim') {
          events.push(['claim', Date.now()]);
          return remoteClaimResponse(body);
        }
        const outcome = String(body['outcome']);
        events.push([outcome, Date.now()]);
        return outcome === 'consume'
          ? Response.json({ ok: false }, { status: 409 })
          : hangingJsonResponse(200);
      });
      const downloadSessions = durableNamespace(async (request) => {
        const path = new URL(request.url).pathname;
        events.push([path.slice(1), Date.now()]);
        return path === '/initialize' ? remoteInitializeResponse() : never();
      });
      const outcome = expectIssueError(
        createRemoteDownloadSessionIssuer({ sessions, downloadSessions }).issue(input),
        'DOWNLOAD_CANDIDATE_UNAVAILABLE',
      );

      await vi.advanceTimersByTimeAsync(RESOLVE_VAULT_REQUEST_TIMEOUT_MS * 3);
      await outcome;
      expect(events.map(([event]) => event)).toEqual([
        'claim',
        'initialize',
        'consume',
        'destroy',
        'release',
        'release',
      ]);
      const destroyAt = events[3]![1];
      const firstReleaseAt = events[4]![1];
      const secondReleaseAt = events[5]![1];
      expect(firstReleaseAt - destroyAt).toBe(DOWNLOAD_SESSION_CLIENT_REQUEST_TIMEOUT_MS);
      expect(secondReleaseAt - firstReleaseAt).toBe(RESOLVE_VAULT_REQUEST_TIMEOUT_MS);
    } finally {
      vi.useRealTimers();
    }
  });
});

import { describe, expect, it, vi } from 'vitest';

import type { ProbedMedia } from '../src/resolver/media-probe.js';
import {
  acquireDownloadSessionStream,
  decodeDownloadSessionAckResponse,
  decodeDownloadSessionAcquireRequest,
  decodeDownloadSessionAcquireResponse,
  decodeDownloadSessionFinishRequest,
  decodeDownloadSessionIdentityRequest,
  decodeDownloadSessionInitializeRequest,
  decodeDownloadSessionInitializeResponse,
  decodeDownloadSessionMetadataHeaders,
  decodeDownloadSessionRenewResponse,
  decodeDownloadSessionStatusResponse,
  destroyDownloadSession,
  DOWNLOAD_SESSION_CLIENT_REQUEST_TIMEOUT_MS,
  downloadHeaderEvidenceSource,
  DownloadSessionClientError,
  encodeDownloadHeaderEvidence,
  finishDownloadSessionStream,
  initializeDownloadSession,
  inspectDownloadSession,
  interruptDownloadSessionStream,
  readDownloadSessionStatus,
  renewDownloadSessionStream,
  type DownloadSessionClientErrorCode,
  type DownloadSessionNamespace,
} from '../src/security/download-session-client.js';
import { parseCdnUrl } from '../src/security/upstream-policy.js';
import { encodeProbedMediaWire } from '../src/security/resolve-vault.js';
import { decodeBase64Url, encodeBase64Url } from '../src/utils/base64url.js';

const PRIVATE_URL =
  'https://video.cdninstagram.com/media/private.mp4?token=must-never-appear-in-errors';
const LAST_MODIFIED = 'Mon, 01 Jan 2024 00:00:00 GMT';

function bytes(length: number, offset = 0): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index + offset) % 256);
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

const downloadId = encodeBase64Url(bytes(24, 1));
const sessionHash = encodeBase64Url(bytes(32, 2));
const holderId = encodeBase64Url(bytes(24, 3));
const identity = { downloadId, sessionHash };

function media(overrides: Partial<ProbedMedia> = {}): ProbedMedia {
  return {
    finalUrl: parseCdnUrl(PRIVATE_URL),
    contentType: 'video/mp4',
    contentLength: 100,
    rangeCapability: 'bytes',
    strongEtag: '"v1"',
    lastModified: LAST_MODIFIED,
    validator: { kind: 'etag', value: '"v1"' },
    completionReliable: true,
    probeMethod: 'head',
    ...overrides,
  };
}

const initializeResponse = {
  ok: true,
  issuedAt: 1_000,
  startExpiresAt: 121_000,
  absoluteExpiresAt: 3_601_000,
} as const;

const statusResponse = {
  ok: true,
  status: 'ACTIVE',
  available: true,
  startExpiresAt: 121_000,
  idleExpiresAt: 601_000,
  absoluteExpiresAt: 3_601_000,
  completionExpiresAt: null,
  activeStreams: 1,
  filename: 'threads_Abcde_1.mp4',
  contentType: 'video/mp4',
  contentLength: 100,
  strongEtag: '"v1"',
  lastModified: LAST_MODIFIED,
  rangeCapability: 'bytes',
} as const;

const acquireResponse = {
  ok: true,
  holderId,
  sequence: 0,
  expiresAt: 901_000,
  request: {
    requestedInterval: { start: 10, end: 19, total: 100 },
    representationPin: { total: 100, validator: { kind: 'etag', value: '"v1"' } },
  },
  media: encodeProbedMediaWire(media()),
} as const;

function namespace(
  handler: (request: Request) => Promise<Response>,
  names: string[] = [],
  ids: DurableObjectId[] = [],
): DownloadSessionNamespace {
  return {
    idFromName(name) {
      names.push(name);
      return { name } as unknown as DurableObjectId;
    },
    get(id) {
      ids.push(id);
      return { fetch: handler };
    },
  };
}

async function json(request: Request): Promise<unknown> {
  return request.json();
}

async function expectClientError(
  action: Promise<unknown>,
  code: DownloadSessionClientErrorCode,
  status: number,
  secrets: readonly string[] = [],
): Promise<void> {
  let caught: unknown;
  try {
    await action;
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DownloadSessionClientError);
  expect(caught).toMatchObject({ code, status, message: code });
  const serialized = JSON.stringify(caught);
  for (const secret of secrets) {
    expect((caught as Error).message).not.toContain(secret);
    expect(serialized).not.toContain(secret);
  }
}

describe('download session exact request decoders', () => {
  const initialize = {
    ...identity,
    filename: 'threads_Abcde_1.mp4',
    shortcode: 'Abcde_1',
    media: encodeProbedMediaWire(media()),
  };

  it('accepts canonical 192-bit IDs and exact initialize and identity shapes', () => {
    expect(decodeDownloadSessionInitializeRequest(initialize)).toEqual({
      ...initialize,
      media: media(),
    });
    expect(decodeDownloadSessionIdentityRequest(identity)).toEqual(identity);

    expect(decodeDownloadSessionIdentityRequest({ ...identity, extra: true })).toBeNull();
    const invalidDownloadId = decodeDownloadSessionIdentityRequest({
      ...identity,
      downloadId: '!'.repeat(32),
    });
    expect(invalidDownloadId).toBeNull();
    expect(
      decodeDownloadSessionIdentityRequest({ ...identity, sessionHash: sessionHash.slice(0, -1) }),
    ).toBeNull();
    expect(
      decodeDownloadSessionInitializeRequest({ ...initialize, rawUrl: PRIVATE_URL }),
    ).toBeNull();
    const unsafeFilename = decodeDownloadSessionInitializeRequest({
      ...initialize,
      filename: '../private.mp4',
    });
    expect(unsafeFilename).toBeNull();
    expect(
      decodeDownloadSessionInitializeRequest({
        ...initialize,
        media: { ...initialize.media, cookie: 'private' },
      }),
    ).toBeNull();
  });

  it('enforces exact acquire headers and finish evidence boundaries', () => {
    const acquire = { ...identity, rangeHeader: 'bytes=0-9', ifRangeHeader: '"v1"' };
    expect(decodeDownloadSessionAcquireRequest(acquire)).toEqual(acquire);
    expect(
      decodeDownloadSessionAcquireRequest({
        ...acquire,
        rangeHeader: 'x'.repeat(512),
      }),
    ).not.toBeNull();
    expect(
      decodeDownloadSessionAcquireRequest({
        ...acquire,
        rangeHeader: 'x'.repeat(513),
      }),
    ).toBeNull();
    expect(decodeDownloadSessionAcquireRequest({ ...acquire, holderId })).toBeNull();

    const finish = {
      ...identity,
      holderId,
      sequence: Number.MAX_SAFE_INTEGER,
      normalEof: true,
      actualBytes: Number.MAX_SAFE_INTEGER,
      upstream: {
        status: 206,
        headers: {
          contentLength: '10',
          contentRange: 'bytes 0-9/100',
          etag: '"v1"',
          lastModified: null,
        },
      },
    } as const;
    expect(decodeDownloadSessionFinishRequest(finish)).toEqual(finish);
    expect(decodeDownloadSessionFinishRequest({ ...finish, sequence: -1 })).toBeNull();
    expect(
      decodeDownloadSessionFinishRequest({
        ...finish,
        upstream: { ...finish.upstream, status: 204 },
      }),
    ).toBeNull();
    expect(
      decodeDownloadSessionFinishRequest({
        ...finish,
        upstream: {
          ...finish.upstream,
          headers: { ...finish.upstream.headers, authorization: 'private' },
        },
      }),
    ).toBeNull();
  });
});

describe('download session strict response decoders', () => {
  it('accepts only exact, ordered deadline initialize responses', () => {
    expect(decodeDownloadSessionInitializeResponse(initializeResponse)).toEqual(initializeResponse);
    expect(
      decodeDownloadSessionInitializeResponse({ ...initializeResponse, internal: 'private' }),
    ).toBeNull();
    expect(
      decodeDownloadSessionInitializeResponse({
        ...initializeResponse,
        startExpiresAt: initializeResponse.issuedAt,
      }),
    ).toBeNull();
    expect(
      decodeDownloadSessionInitializeResponse({
        ...initializeResponse,
        absoluteExpiresAt: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toBeNull();
  });

  it('rejects missing, extra, inconsistent, and unsafe status fields', () => {
    expect(decodeDownloadSessionStatusResponse(statusResponse)).toEqual(statusResponse);
    const missing: Record<string, unknown> = { ...statusResponse };
    delete missing['filename'];
    expect(decodeDownloadSessionStatusResponse(missing)).toBeNull();
    expect(decodeDownloadSessionStatusResponse({ ...statusResponse, issuedAt: 1_000 })).toBeNull();
    expect(
      decodeDownloadSessionStatusResponse({
        ...statusResponse,
        status: 'EXPIRED',
        available: true,
      }),
    ).toBeNull();
    expect(
      decodeDownloadSessionStatusResponse({ ...statusResponse, activeStreams: 0.5 }),
    ).toBeNull();
    expect(decodeDownloadSessionStatusResponse({ ...statusResponse, contentLength: 0 })).toBeNull();
    expect(decodeDownloadSessionStatusResponse({ ...statusResponse, activeStreams: 5 })).toBeNull();
    expect(
      decodeDownloadSessionStatusResponse({ ...statusResponse, idleExpiresAt: null }),
    ).toBeNull();
    expect(
      decodeDownloadSessionStatusResponse({
        ...statusResponse,
        absoluteExpiresAt: statusResponse.absoluteExpiresAt + 1,
      }),
    ).toBeNull();
    expect(
      decodeDownloadSessionStatusResponse({
        ...statusResponse,
        status: 'ISSUED',
        idleExpiresAt: null,
        activeStreams: 0,
      }),
    ).not.toBeNull();
    expect(
      decodeDownloadSessionStatusResponse({
        ...statusResponse,
        status: 'INTERRUPTED',
        activeStreams: 0,
      }),
    ).not.toBeNull();
    expect(
      decodeDownloadSessionStatusResponse({
        ...statusResponse,
        status: 'COMPLETE_PENDING',
        completionExpiresAt: 600_000,
        activeStreams: 0,
      }),
    ).not.toBeNull();
    expect(
      decodeDownloadSessionStatusResponse({
        ...statusResponse,
        status: 'COMPLETE_PENDING',
        completionExpiresAt: 602_000,
        activeStreams: 0,
      }),
    ).toBeNull();
  });

  it('strictly decodes lease request plans, media, renewals, and acknowledgements', () => {
    const decoded = decodeDownloadSessionAcquireResponse(acquireResponse);
    expect(decoded).toEqual({ ...acquireResponse, media: media() });
    expect(decodeDownloadSessionAcquireResponse({ ...acquireResponse, sequence: 1 })).toBeNull();
    expect(
      decodeDownloadSessionAcquireResponse({
        ...acquireResponse,
        request: {
          ...acquireResponse.request,
          requestedInterval: { start: 20, end: 19, total: 100 },
        },
      }),
    ).toBeNull();
    expect(
      decodeDownloadSessionAcquireResponse({
        ...acquireResponse,
        media: { ...acquireResponse.media, contentLength: 101 },
      }),
    ).toBeNull();
    expect(
      decodeDownloadSessionAcquireResponse({
        ...acquireResponse,
        media: { ...acquireResponse.media, strongEtag: '"v2"' },
      }),
    ).toBeNull();
    expect(
      decodeDownloadSessionAcquireResponse({
        ...acquireResponse,
        request: { ...acquireResponse.request, representationPin: null },
      }),
    ).toBeNull();
    expect(
      decodeDownloadSessionAcquireResponse({
        ...acquireResponse,
        request: {
          ...acquireResponse.request,
          requestedInterval: { start: 10, end: 19, total: 99 },
        },
      }),
    ).toBeNull();
    expect(
      decodeDownloadSessionAcquireResponse({
        ...acquireResponse,
        request: {
          ...acquireResponse.request,
          representationPin: {
            total: 100,
            validator: { kind: 'etag', value: 'W/"weak"' },
          },
        },
      }),
    ).toBeNull();
    expect(
      decodeDownloadSessionAcquireResponse({
        ...acquireResponse,
        media: { ...acquireResponse.media, rawCookie: 'private' },
      }),
    ).toBeNull();

    const unreliableMedia = media({
      contentLength: null,
      strongEtag: null,
      lastModified: null,
      validator: null,
      rangeCapability: 'unknown',
      completionReliable: false,
    });
    expect(
      decodeDownloadSessionAcquireResponse({
        ...acquireResponse,
        request: { requestedInterval: null, representationPin: null },
        media: encodeProbedMediaWire(unreliableMedia),
      }),
    ).toEqual({
      ...acquireResponse,
      request: { requestedInterval: null, representationPin: null },
      media: unreliableMedia,
    });

    const renewal = { ok: true, holderId, sequence: Number.MAX_SAFE_INTEGER, expiresAt: 1 };
    expect(decodeDownloadSessionRenewResponse(renewal)).toEqual(renewal);
    expect(decodeDownloadSessionRenewResponse({ ...renewal, sequence: -1 })).toBeNull();
    expect(decodeDownloadSessionRenewResponse({ ...renewal, holderId: 'x' })).toBeNull();
    expect(decodeDownloadSessionAckResponse({ ok: true })).toEqual({ ok: true });
    expect(decodeDownloadSessionAckResponse({ ok: true, detail: 'private' })).toBeNull();
    expect(decodeDownloadSessionAckResponse({ ok: false })).toBeNull();
  });
});

describe('download session namespace client', () => {
  it('generates and routes initialization by its canonical 192-bit download ID', async () => {
    const requests: Request[] = [];
    const names: string[] = [];
    const ids: DurableObjectId[] = [];
    const sessions = namespace(
      async (request) => {
        requests.push(request.clone() as unknown as Request);
        return Response.json(initializeResponse, { status: 201 });
      },
      names,
      ids,
    );

    const initialized = await initializeDownloadSession(sessions, {
      sessionHash,
      filename: 'threads_Abcde_1.mp4',
      shortcode: 'Abcde_1',
      media: media(),
    });

    expect(names).toEqual([initialized.downloadId]);
    expect(ids).toHaveLength(1);
    expect((ids[0] as unknown as { name: string }).name).toBe(initialized.downloadId);
    expect(initialized).toEqual({
      downloadId: names[0],
      issuedAt: initializeResponse.issuedAt,
      startExpiresAt: initializeResponse.startExpiresAt,
      absoluteExpiresAt: initializeResponse.absoluteExpiresAt,
    });
    expect(decodeBase64Url(initialized.downloadId)).toHaveLength(24);
    expect(requests[0]?.method).toBe('POST');
    expect(new URL(requests[0]!.url).pathname).toBe('/initialize');
    expect(requests[0]?.headers.get('content-type')).toBe('application/json');
    expect(await json(requests[0]!)).toEqual({
      downloadId: initialized.downloadId,
      sessionHash,
      filename: 'threads_Abcde_1.mp4',
      shortcode: 'Abcde_1',
      media: encodeProbedMediaWire(media()),
    });
  });

  it('sends the exact inspect, status, acquire, renew, finish, interrupt, and destroy shapes', async () => {
    const requests: Request[] = [];
    const names: string[] = [];
    const sessions = namespace(async (request) => {
      requests.push(request.clone() as unknown as Request);
      switch (new URL(request.url).pathname) {
        case '/inspect':
          return new Response(null, {
            status: 200,
            headers: {
              'x-download-filename': statusResponse.filename,
              'content-type': statusResponse.contentType,
              'content-length': String(statusResponse.contentLength),
              etag: statusResponse.strongEtag,
              'last-modified': statusResponse.lastModified,
              'x-download-range-capability': statusResponse.rangeCapability,
            },
          });
        case '/status':
          return Response.json(statusResponse);
        case '/acquire':
          return Response.json(acquireResponse, { status: 201 });
        case '/renew':
          return Response.json({ ok: true, holderId, sequence: 1, expiresAt: 902_000 });
        default:
          return Response.json({ ok: true });
      }
    }, names);

    expect(await inspectDownloadSession(sessions, identity)).toEqual({
      filename: statusResponse.filename,
      contentType: statusResponse.contentType,
      contentLength: statusResponse.contentLength,
      strongEtag: statusResponse.strongEtag,
      lastModified: statusResponse.lastModified,
      rangeCapability: statusResponse.rangeCapability,
    });
    expect(await readDownloadSessionStatus(sessions, identity)).toEqual({
      status: statusResponse.status,
      available: statusResponse.available,
      startExpiresAt: statusResponse.startExpiresAt,
      idleExpiresAt: statusResponse.idleExpiresAt,
      absoluteExpiresAt: statusResponse.absoluteExpiresAt,
      completionExpiresAt: statusResponse.completionExpiresAt,
      activeStreams: statusResponse.activeStreams,
      filename: statusResponse.filename,
      contentType: statusResponse.contentType,
      contentLength: statusResponse.contentLength,
      strongEtag: statusResponse.strongEtag,
      lastModified: statusResponse.lastModified,
      rangeCapability: statusResponse.rangeCapability,
    });
    expect(
      await acquireDownloadSessionStream(sessions, {
        ...identity,
        rangeHeader: 'bytes=10-19',
        ifRangeHeader: '"v1"',
      }),
    ).toEqual({
      holderId,
      sequence: 0,
      expiresAt: acquireResponse.expiresAt,
      request: acquireResponse.request,
      media: media(),
    });
    expect(
      await renewDownloadSessionStream(sessions, { ...identity, holderId, sequence: 1 }),
    ).toEqual({ holderId, sequence: 1, expiresAt: 902_000 });
    await finishDownloadSessionStream(sessions, {
      ...identity,
      holderId,
      sequence: 1,
      normalEof: true,
      actualBytes: 10,
      upstream: {
        status: 206,
        headers: {
          contentLength: '10',
          contentRange: 'bytes 10-19/100',
          etag: '"v1"',
          lastModified: LAST_MODIFIED,
        },
      },
    });
    await interruptDownloadSessionStream(sessions, { ...identity, holderId, sequence: 2 });
    await destroyDownloadSession(sessions, identity);

    expect(names).toEqual(Array.from({ length: 7 }, () => downloadId));
    expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
      ['HEAD', '/inspect'],
      ['POST', '/status'],
      ['POST', '/acquire'],
      ['POST', '/renew'],
      ['POST', '/finish'],
      ['POST', '/interrupt'],
      ['POST', '/destroy'],
    ]);
    expect(requests[0]?.headers.get('x-download-id')).toBe(downloadId);
    expect(requests[0]?.headers.get('x-session-hash')).toBe(sessionHash);
    expect(await json(requests[1]!)).toEqual(identity);
    expect(await json(requests[2]!)).toEqual({
      ...identity,
      rangeHeader: 'bytes=10-19',
      ifRangeHeader: '"v1"',
    });
    expect(await json(requests[3]!)).toEqual({ ...identity, holderId, sequence: 1 });
    expect(await json(requests[4]!)).toEqual({
      ...identity,
      holderId,
      sequence: 1,
      normalEof: true,
      actualBytes: 10,
      upstream: {
        status: 206,
        headers: {
          contentLength: '10',
          contentRange: 'bytes 10-19/100',
          etag: '"v1"',
          lastModified: LAST_MODIFIED,
        },
      },
    });
    expect(await json(requests[5]!)).toEqual({ ...identity, holderId, sequence: 2 });
    expect(await json(requests[6]!)).toEqual(identity);
  });

  it('does not compensate a definite initialize conflict', async () => {
    const requests: Request[] = [];
    const sessions = namespace(async (request) => {
      requests.push(request.clone() as unknown as Request);
      return Response.json({ ok: false, detail: PRIVATE_URL }, { status: 409 });
    });

    await expectClientError(
      initializeDownloadSession(sessions, {
        sessionHash,
        filename: 'threads_Abcde_1.mp4',
        shortcode: 'Abcde_1',
        media: media(),
      }),
      'DOWNLOAD_SESSION_CONFLICT',
      409,
      [PRIVATE_URL, sessionHash],
    );
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual(['/initialize']);
  });

  it.each(['network', 'malformed'] as const)(
    'best-effort destroys after an uncertain %s initialize result',
    async (failure) => {
      const requests: Request[] = [];
      const sessions = namespace(async (request) => {
        requests.push(request.clone() as unknown as Request);
        if (requests.length === 1) {
          if (failure === 'network') {
            throw new Error(PRIVATE_URL);
          }
          return Response.json({ ...initializeResponse, privateUrl: PRIVATE_URL }, { status: 201 });
        }
        return Response.json({ ok: true });
      });

      await expectClientError(
        initializeDownloadSession(sessions, {
          sessionHash,
          filename: 'threads_Abcde_1.mp4',
          shortcode: 'Abcde_1',
          media: media(),
        }),
        'DOWNLOAD_SESSION_UNAVAILABLE',
        503,
        [PRIVATE_URL, sessionHash],
      );
      expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
        '/initialize',
        '/destroy',
      ]);
      const initialized = (await json(requests[0]!)) as Record<string, unknown>;
      expect(await json(requests[1]!)).toEqual({
        downloadId: initialized['downloadId'],
        sessionHash,
      });
    },
  );

  it.each(['initialize', 'initialize-body', 'compensation'] as const)(
    'bounds a never-settling %s request during uncertain initialization',
    async (stalledRequest) => {
      vi.useFakeTimers();
      try {
        const requests: Request[] = [];
        const sessions = namespace(async (request) => {
          requests.push(request.clone() as unknown as Request);
          if (requests.length === 1) {
            if (stalledRequest === 'initialize') {
              return never();
            }
            if (stalledRequest === 'initialize-body') {
              return hangingJsonResponse(201);
            }
            return Promise.reject(new Error('ambiguous initialize transport'));
          }
          return stalledRequest === 'compensation' ? never() : Response.json({ ok: true });
        });
        const outcome = expectClientError(
          initializeDownloadSession(sessions, {
            sessionHash,
            filename: 'threads_Abcde_1.mp4',
            shortcode: 'Abcde_1',
            media: media(),
          }),
          'DOWNLOAD_SESSION_UNAVAILABLE',
          503,
          [PRIVATE_URL, sessionHash],
        );

        await vi.advanceTimersByTimeAsync(DOWNLOAD_SESSION_CLIENT_REQUEST_TIMEOUT_MS);
        await outcome;
        expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
          '/initialize',
          '/destroy',
        ]);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('bounds a never-settling destroy acknowledgement body', async () => {
    vi.useFakeTimers();
    try {
      const outcome = expectClientError(
        destroyDownloadSession(
          namespace(async () => hangingJsonResponse(200)),
          identity,
        ),
        'DOWNLOAD_SESSION_UNAVAILABLE',
        503,
      );
      await vi.advanceTimersByTimeAsync(DOWNLOAD_SESSION_CLIENT_REQUEST_TIMEOUT_MS);
      await outcome;
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['inspect', 'status', 'status-body'] as const)(
    'bounds a never-settling read-only %s operation',
    async (operation) => {
      vi.useFakeTimers();
      try {
        const sessions = namespace(async () => {
          if (operation === 'status-body') {
            return hangingJsonResponse(200);
          }
          return never();
        });
        const outcome = expectClientError(
          operation === 'inspect'
            ? inspectDownloadSession(sessions, identity)
            : readDownloadSessionStatus(sessions, identity),
          'DOWNLOAD_SESSION_UNAVAILABLE',
          503,
        );
        await vi.advanceTimersByTimeAsync(DOWNLOAD_SESSION_CLIENT_REQUEST_TIMEOUT_MS);
        await outcome;
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('compensates a 500 initialize failure without reading or leaking its body', async () => {
    const requests: Request[] = [];
    const failure = Response.json({ detail: PRIVATE_URL, sessionHash }, { status: 500 });
    const jsonSpy = vi.spyOn(failure, 'json');
    const sessions = namespace(async (request) => {
      requests.push(request.clone() as unknown as Request);
      return requests.length === 1 ? failure : Response.json({ ok: true });
    });

    await expectClientError(
      initializeDownloadSession(sessions, {
        sessionHash,
        filename: 'threads_Abcde_1.mp4',
        shortcode: 'Abcde_1',
        media: media(),
      }),
      'DOWNLOAD_SESSION_UNAVAILABLE',
      503,
      [PRIVATE_URL, sessionHash],
    );
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      '/initialize',
      '/destroy',
    ]);
  });

  it('rejects successful acquire plans that do not exactly match the caller range decision', async () => {
    const cases = [
      {
        name: 'no range with an interval',
        rangeHeader: null,
        ifRangeHeader: null,
        requestedInterval: { start: 10, end: 19, total: 100 },
      },
      {
        name: 'valid range with a different interval',
        rangeHeader: 'bytes=10-19',
        ifRangeHeader: null,
        requestedInterval: { start: 11, end: 19, total: 100 },
      },
      {
        name: 'invalid range with a fabricated interval',
        rangeHeader: 'bytes=invalid',
        ifRangeHeader: null,
        requestedInterval: { start: 10, end: 19, total: 100 },
      },
    ] as const;

    for (const testCase of cases) {
      await expectClientError(
        acquireDownloadSessionStream(
          namespace(async () =>
            Response.json(
              {
                ...acquireResponse,
                request: {
                  ...acquireResponse.request,
                  requestedInterval: testCase.requestedInterval,
                },
              },
              { status: 201 },
            ),
          ),
          {
            ...identity,
            rangeHeader: testCase.rangeHeader,
            ifRangeHeader: testCase.ifRangeHeader,
          },
        ),
        'DOWNLOAD_SESSION_UNAVAILABLE',
        503,
      );
    }
  });

  it('accepts a full plan when If-Range does not match the decoded media validator', async () => {
    const response = {
      ...acquireResponse,
      request: { ...acquireResponse.request, requestedInterval: null },
    };
    await expect(
      acquireDownloadSessionStream(
        namespace(async () => Response.json(response, { status: 201 })),
        { ...identity, rangeHeader: 'bytes=10-19', ifRangeHeader: '"different"' },
      ),
    ).resolves.toMatchObject({ request: { requestedInterval: null } });
  });

  it('fails closed when a successful effective range response reports no range capability', async () => {
    const response = {
      ...acquireResponse,
      media: encodeProbedMediaWire(media({ rangeCapability: 'none' })),
    };
    await expectClientError(
      acquireDownloadSessionStream(
        namespace(async () => Response.json(response, { status: 201 })),
        { ...identity, rangeHeader: 'bytes=10-19', ifRangeHeader: '"v1"' },
      ),
      'DOWNLOAD_SESSION_UNAVAILABLE',
      503,
    );
  });

  it('maps statuses and malformed success bodies to fixed errors without reading failure bodies', async () => {
    const failure = Response.json({ detail: PRIVATE_URL, sessionHash }, { status: 401 });
    const jsonSpy = vi.spyOn(failure, 'json');
    await expectClientError(
      readDownloadSessionStatus(
        namespace(async () => failure),
        identity,
      ),
      'DOWNLOAD_SESSION_UNAUTHORIZED',
      401,
      [PRIVATE_URL, sessionHash],
    );
    expect(jsonSpy).not.toHaveBeenCalled();

    await expectClientError(
      acquireDownloadSessionStream(
        namespace(async () => Response.json(acquireResponse)),
        {
          ...identity,
          rangeHeader: null,
          ifRangeHeader: null,
        },
      ),
      'DOWNLOAD_SESSION_UNAVAILABLE',
      503,
      [PRIVATE_URL, sessionHash],
    );
    await expectClientError(
      destroyDownloadSession(
        namespace(async () => Response.json({ ok: true, detail: PRIVATE_URL })),
        identity,
      ),
      'DOWNLOAD_SESSION_UNAVAILABLE',
      503,
      [PRIVATE_URL, sessionHash],
    );
    await expectClientError(
      destroyDownloadSession(
        namespace(
          async () =>
            new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { 'content-type': 'text/plain' },
            }),
        ),
        identity,
      ),
      'DOWNLOAD_SESSION_UNAVAILABLE',
      503,
    );
  });

  it('exposes only a canonical unsatisfied content-range on 416', async () => {
    let caught: unknown;
    try {
      await acquireDownloadSessionStream(
        namespace(async () =>
          Response.json(
            { ok: false, detail: PRIVATE_URL },
            { status: 416, headers: { 'content-range': 'bytes */100' } },
          ),
        ),
        { ...identity, rangeHeader: 'bytes=100-', ifRangeHeader: null },
      );
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: 'DOWNLOAD_SESSION_RANGE_UNAVAILABLE',
      status: 416,
      contentRange: 'bytes */100',
    });
    expect(JSON.stringify(caught)).not.toContain(PRIVATE_URL);

    let missing: unknown;
    try {
      await acquireDownloadSessionStream(
        namespace(async () => Response.json({ ok: false }, { status: 416 })),
        { ...identity, rangeHeader: 'bytes=100-', ifRangeHeader: null },
      );
    } catch (error: unknown) {
      missing = error;
    }
    expect(missing).toMatchObject({
      code: 'DOWNLOAD_SESSION_RANGE_UNAVAILABLE',
      status: 416,
    });
    expect(missing).not.toHaveProperty('contentRange');

    for (const contentRange of ['bytes */0', 'bytes */01', 'bytes 0-1/100', 'private']) {
      await expectClientError(
        acquireDownloadSessionStream(
          namespace(async () =>
            Response.json(
              { ok: false },
              {
                status: 416,
                headers: { 'content-range': contentRange },
              },
            ),
          ),
          { ...identity, rangeHeader: 'bytes=100-', ifRangeHeader: null },
        ),
        'DOWNLOAD_SESSION_UNAVAILABLE',
        503,
      );
    }
  });

  it.each([
    [410, 'DOWNLOAD_SESSION_EXPIRED', 410],
    [429, 'DOWNLOAD_SESSION_CONCURRENT_LIMIT', 429],
    [500, 'DOWNLOAD_SESSION_UNAVAILABLE', 503],
    [599, 'DOWNLOAD_SESSION_UNAVAILABLE', 503],
  ] as const)('maps a non-success %i to fixed %s/%i', async (responseStatus, code, status) => {
    await expectClientError(
      acquireDownloadSessionStream(
        namespace(async () =>
          Response.json({ ok: false, detail: PRIVATE_URL }, { status: responseStatus }),
        ),
        { ...identity, rangeHeader: null, ifRangeHeader: null },
      ),
      code,
      status,
      [PRIVATE_URL, sessionHash],
    );
  });

  it('rejects invalid caller identities before namespace routing', async () => {
    const idFromName = vi.fn(() => ({}) as DurableObjectId);
    const sessions: DownloadSessionNamespace = {
      idFromName,
      get: vi.fn(() => ({ fetch: vi.fn() })),
    };
    await expectClientError(
      destroyDownloadSession(sessions, { ...identity, downloadId: 'not-canonical' }),
      'DOWNLOAD_SESSION_REQUEST_INVALID',
      400,
    );
    expect(idFromName).not.toHaveBeenCalled();
  });
});

describe('download header evidence', () => {
  it('round-trips only the four allowlisted headers case-insensitively', () => {
    const headers = new Headers({
      'content-length': '10',
      'content-range': 'bytes 0-9/100',
      etag: '"v1"',
      'last-modified': LAST_MODIFIED,
      authorization: 'private',
    });
    const evidence = encodeDownloadHeaderEvidence(headers);
    expect(evidence).toEqual({
      contentLength: '10',
      contentRange: 'bytes 0-9/100',
      etag: '"v1"',
      lastModified: LAST_MODIFIED,
    });
    const source = downloadHeaderEvidenceSource(evidence);
    expect(source.get('CONTENT-RANGE')).toBe('bytes 0-9/100');
    expect(source.get('authorization')).toBeNull();
  });

  it('strictly decodes the safe HEAD metadata snapshot', () => {
    const valid = new Headers({
      'x-download-filename': 'threads_Abcde_1.mp4',
      'content-type': 'video/mp4',
      'content-length': '100',
      etag: '"v1"',
      'last-modified': LAST_MODIFIED,
      'x-download-range-capability': 'bytes',
    });
    expect(decodeDownloadSessionMetadataHeaders(valid)).toEqual({
      filename: 'threads_Abcde_1.mp4',
      contentType: 'video/mp4',
      contentLength: 100,
      strongEtag: '"v1"',
      lastModified: LAST_MODIFIED,
      rangeCapability: 'bytes',
    });

    const optional = new Headers(valid);
    optional.delete('content-length');
    optional.delete('etag');
    optional.delete('last-modified');
    expect(decodeDownloadSessionMetadataHeaders(optional)).toMatchObject({
      contentLength: null,
      strongEtag: null,
      lastModified: null,
    });
    for (const [name, value] of [
      ['x-download-filename', '../private.mp4'],
      ['content-type', 'text/html'],
      ['content-length', '01'],
      ['etag', 'W/"weak"'],
      ['last-modified', 'yesterday'],
      ['x-download-range-capability', 'private'],
    ] as const) {
      const invalid = new Headers(valid);
      invalid.set(name, value);
      expect(decodeDownloadSessionMetadataHeaders(invalid)).toBeNull();
    }
  });
});

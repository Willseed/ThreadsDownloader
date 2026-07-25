import { describe, expect, it, vi } from 'vitest';

import type { ProbedMedia } from '../src/resolver/media-probe.js';
import {
  DownloadSessionClientError,
  type DownloadSessionNamespace,
} from '../src/security/download-session-client.js';
import type {
  SessionDownloadAdmission,
  SessionDownloadAdmissionPort,
} from '../src/security/session-download-admission-client.js';
import { parseCdnUrl } from '../src/security/upstream-policy.js';
import { encodeProbedMediaWire } from '../src/security/resolve-vault.js';
import {
  createDownloadDelivery,
  DOWNLOAD_LIFECYCLE_MUTATION_TIMEOUT_MS,
  DownloadDeliveryError,
  type DownloadDeliveryInput,
} from '../src/streaming/download-delivery.js';
import { encodeBase64Url } from '../src/utils/base64url.js';

const PRIVATE_URL = 'https://video.cdninstagram.com/private/video.mp4?token=must-never-be-exposed';
const REDIRECT_URL = 'https://edge.cdninstagram.com/private/video.mp4?token=redirect-private';
const LAST_MODIFIED = 'Mon, 01 Jan 2024 00:00:00 GMT';

function bytes(length: number, offset = 0): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index + offset) % 256);
}

const downloadId = encodeBase64Url(bytes(24, 1));
const rawId = encodeBase64Url(bytes(32, 4));
const sessionHash = encodeBase64Url(bytes(32, 2));
const holderId = encodeBase64Url(bytes(24, 3));

const input: DownloadDeliveryInput = {
  session: { rawId, sessionHash },
  downloadId,
  rangeHeader: null,
  ifRangeHeader: null,
};

function media(overrides: Partial<ProbedMedia> = {}): ProbedMedia {
  return {
    finalUrl: parseCdnUrl(PRIVATE_URL),
    contentType: 'video/mp4',
    contentLength: 4,
    rangeCapability: 'bytes',
    strongEtag: '"v1"',
    lastModified: LAST_MODIFIED,
    validator: { kind: 'etag', value: '"v1"' },
    completionReliable: true,
    probeMethod: 'head',
    ...overrides,
  };
}

interface InternalCall {
  readonly body: unknown;
  readonly method: string;
  readonly path: string;
}

interface SessionHarnessOptions {
  readonly acquiredMedia?: ProbedMedia;
  readonly acquireResponse?: Response;
  readonly requestedInterval?: {
    readonly start: number;
    readonly end: number;
    readonly total: number;
  } | null;
  readonly renew?: (body: Record<string, unknown>) => Promise<Response>;
  readonly finish?: (body: Record<string, unknown>) => Promise<Response>;
  readonly interrupt?: (body: Record<string, unknown>) => Promise<Response>;
  readonly admissionAcquire?: () => Promise<SessionDownloadAdmission>;
  readonly admissionRenew?: () => Promise<void>;
  readonly admissionRelease?: () => Promise<void>;
}

function inspectResponse(acquiredMedia: ProbedMedia): Response {
  const headers = new Headers({
    'content-type': acquiredMedia.contentType,
    'x-download-filename': 'threads_Abcde_1.mp4',
    'x-download-range-capability': acquiredMedia.rangeCapability,
  });
  if (acquiredMedia.contentLength !== null) {
    headers.set('content-length', String(acquiredMedia.contentLength));
  }
  if (acquiredMedia.strongEtag !== null) {
    headers.set('etag', acquiredMedia.strongEtag);
  }
  if (acquiredMedia.lastModified !== null) {
    headers.set('last-modified', acquiredMedia.lastModified);
  }
  return new Response(null, { status: 200, headers });
}

function successfulAcquireResponse(
  acquiredMedia: ProbedMedia,
  requestedInterval: SessionHarnessOptions['requestedInterval'],
): Response {
  return Response.json(
    {
      ok: true,
      holderId,
      sequence: 0,
      expiresAt: 900_000,
      request: {
        requestedInterval,
        representationPin:
          acquiredMedia.contentLength === null || acquiredMedia.validator === null
            ? null
            : { total: acquiredMedia.contentLength, validator: acquiredMedia.validator },
      },
      media: encodeProbedMediaWire(acquiredMedia),
    },
    { status: 201 },
  );
}

async function mutationResponse(
  path: string,
  body: Record<string, unknown>,
  options: SessionHarnessOptions,
): Promise<Response> {
  if (path === '/renew') {
    return options.renew === undefined
      ? Response.json({
          ok: true,
          holderId,
          sequence: body['sequence'],
          expiresAt: 930_000,
        })
      : options.renew(body);
  }
  if (path === '/finish') {
    return options.finish === undefined ? Response.json({ ok: true }) : options.finish(body);
  }
  if (path === '/interrupt') {
    return options.interrupt === undefined ? Response.json({ ok: true }) : options.interrupt(body);
  }
  return Response.json({ ok: false }, { status: 404 });
}

function sessionHarness(options: SessionHarnessOptions = {}): {
  readonly admissionCalls: string[];
  readonly admissions: SessionDownloadAdmissionPort;
  readonly calls: InternalCall[];
  readonly events: string[];
  readonly namespace: DownloadSessionNamespace;
} {
  const admissionCalls: string[] = [];
  const calls: InternalCall[] = [];
  const events: string[] = [];
  const acquiredMedia = options.acquiredMedia ?? media();
  const requestedInterval = options.requestedInterval ?? null;
  const namespace: DownloadSessionNamespace = {
    idFromName(name) {
      return { name } as unknown as DurableObjectId;
    },
    get() {
      return {
        async fetch(request) {
          const path = new URL(request.url).pathname;
          const body: unknown = request.method === 'HEAD' ? null : await request.json();
          events.push(`session:${path}`);
          calls.push({ body, method: request.method, path });
          if (path === '/inspect') {
            return inspectResponse(acquiredMedia);
          }
          if (path === '/acquire') {
            return (
              options.acquireResponse ?? successfulAcquireResponse(acquiredMedia, requestedInterval)
            );
          }
          return mutationResponse(path, body as Record<string, unknown>, options);
        },
      };
    },
  };
  const admissions: SessionDownloadAdmissionPort = {
    async acquire() {
      events.push('admission:acquire');
      admissionCalls.push('acquire');
      if (options.admissionAcquire !== undefined) {
        return options.admissionAcquire();
      }
      return {
        async renew() {
          events.push('admission:renew');
          admissionCalls.push('renew');
          await options.admissionRenew?.();
        },
        async release() {
          events.push('admission:release');
          admissionCalls.push('release');
          await options.admissionRelease?.();
        },
      };
    },
  };
  return { admissionCalls, admissions, calls, events, namespace };
}

function videoResponse(
  body: BodyInit | Uint8Array | null = bytes(4),
  init: { readonly headers?: Record<string, string>; readonly status?: number } = {},
): Response {
  const normalizedBody = body instanceof Uint8Array ? body.slice().buffer : body;
  return new Response(normalizedBody, {
    status: init.status ?? 200,
    headers: {
      'content-length': '4',
      'content-type': 'video/mp4',
      etag: '"v1"',
      ...init.headers,
    },
  });
}

function delivery(
  harness: ReturnType<typeof sessionHarness>,
  fetcher: (request: Request) => Promise<Response>,
) {
  return createDownloadDelivery({
    admissions: harness.admissions,
    sessions: harness.namespace,
    fetcher,
  });
}

function paths(harness: ReturnType<typeof sessionHarness>): string[] {
  return harness.calls.map((call) => call.path);
}

function callBody(
  harness: ReturnType<typeof sessionHarness>,
  path: string,
): Record<string, unknown> {
  return harness.calls.find((call) => call.path === path)!.body as Record<string, unknown>;
}

function chunkStream(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = chunks[index];
        index += 1;
        if (chunk === undefined) {
          controller.close();
        } else {
          controller.enqueue(chunk);
        }
      },
    },
    { highWaterMark: 0 },
  );
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe('download delivery setup', () => {
  it('streams a full response through safe headers and never forwards browser credentials', async () => {
    const harness = sessionHarness();
    const requests: Request[] = [];
    const fetcher = vi.fn(async (request: Request) => {
      requests.push(request);
      return videoResponse(bytes(4), {
        headers: {
          authorization: 'private-upstream-value',
          location: PRIVATE_URL,
          server: 'private-origin',
          'set-cookie': 'private-cookie=value',
          'x-private-url': PRIVATE_URL,
        },
      });
    });

    const response = await delivery(harness, fetcher)(input);
    await expect(response.arrayBuffer()).resolves.toHaveProperty('byteLength', 4);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="threads_Abcde_1.mp4"',
    );
    expect(response.headers.get('content-length')).toBe('4');
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('etag')).toBe('"v1"');
    expect(response.headers.get('authorization')).toBeNull();
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('server')).toBeNull();
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('x-private-url')).toBeNull();
    expect(requests[0]!.headers.get('accept')).toBe('*/*');
    expect(requests[0]!.headers.get('accept-encoding')).toBe('identity');
    expect(requests[0]!.headers.get('user-agent')).toBe('threads-downloader/0.1');
    for (const name of ['authorization', 'cookie', 'origin', 'referer', 'sec-fetch-site']) {
      expect(requests[0]!.headers.get(name)).toBeNull();
    }
    expect(paths(harness)).toEqual(['/inspect', '/acquire', '/finish']);
    expect(harness.events).toEqual([
      'session:/inspect',
      'admission:acquire',
      'session:/acquire',
      'admission:renew',
      'session:/finish',
      'admission:release',
    ]);
    expect(JSON.stringify(callBody(harness, '/finish'))).not.toContain(PRIVATE_URL);
  });

  it('canonicalizes a single range and its representation pin', async () => {
    const harness = sessionHarness({
      requestedInterval: { start: 1, end: 2, total: 4 },
    });
    let upstream: Request | undefined;
    const response = await delivery(harness, async (request) => {
      upstream = request;
      return videoResponse(bytes(2), {
        status: 206,
        headers: { 'content-length': '2', 'content-range': 'bytes 1-2/4' },
      });
    })({ ...input, rangeHeader: 'bytes=1-2', ifRangeHeader: '"v1"' });

    await expect(response.arrayBuffer()).resolves.toHaveProperty('byteLength', 2);
    expect(upstream!.headers.get('range')).toBe('bytes=1-2');
    expect(upstream!.headers.get('if-range')).toBe('"v1"');
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 1-2/4');
    expect(response.headers.get('content-length')).toBe('2');
  });

  it('forwards a range without If-Range when the representation has no reliable pin', async () => {
    const acquiredMedia = media({
      completionReliable: false,
      lastModified: null,
      rangeCapability: 'unknown',
      strongEtag: null,
      validator: null,
    });
    const harness = sessionHarness({
      acquiredMedia,
      requestedInterval: { start: 1, end: 2, total: 4 },
    });
    let upstream: Request | undefined;
    const response = await delivery(harness, async (request) => {
      upstream = request;
      return videoResponse(bytes(2), {
        status: 206,
        headers: { 'content-length': '2', 'content-range': 'bytes 1-2/4' },
      });
    })({ ...input, rangeHeader: 'bytes=1-2' });

    await expect(response.arrayBuffer()).resolves.toHaveProperty('byteLength', 2);
    expect(upstream!.headers.get('range')).toBe('bytes=1-2');
    expect(upstream!.headers.get('if-range')).toBeNull();
    expect(response.headers.get('accept-ranges')).toBe('bytes');
  });

  it('accepts a canonical full 200 response when the origin ignores Range', async () => {
    const harness = sessionHarness({
      requestedInterval: { start: 1, end: 2, total: 4 },
    });
    const response = await delivery(harness, async () => videoResponse())({
      ...input,
      rangeHeader: 'bytes=1-2',
    });

    await expect(response.arrayBuffer()).resolves.toHaveProperty('byteLength', 4);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-range')).toBeNull();
    expect(callBody(harness, '/finish')['actualBytes']).toBe(4);
  });

  it('drops a mismatched browser If-Range after the DO selects a full transfer', async () => {
    const harness = sessionHarness({ requestedInterval: null });
    let upstream: Request | undefined;
    const response = await delivery(harness, async (request) => {
      upstream = request;
      return videoResponse();
    })({ ...input, rangeHeader: 'bytes=1-2', ifRangeHeader: '"old"' });

    await response.arrayBuffer();
    expect(upstream!.headers.get('range')).toBeNull();
    expect(upstream!.headers.get('if-range')).toBeNull();
    expect(response.status).toBe(200);
  });

  it('preserves a safe 416 and never contacts the origin for malformed or multi-range input', async () => {
    const harness = sessionHarness({
      acquireResponse: new Response(null, {
        status: 416,
        headers: { 'content-range': 'bytes */4' },
      }),
    });
    const fetcher = vi.fn<(request: Request) => Promise<Response>>();
    let caught: unknown;
    try {
      await delivery(
        harness,
        fetcher,
      )({
        ...input,
        rangeHeader: 'bytes=0-1,2-3',
      });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DownloadSessionClientError);
    expect(caught).toMatchObject({
      code: 'DOWNLOAD_SESSION_RANGE_UNAVAILABLE',
      contentRange: 'bytes */4',
      status: 416,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(paths(harness)).toEqual(['/inspect', '/acquire']);
    expect(harness.admissionCalls).toEqual(['acquire', 'release']);
  });

  it('follows only validated manual CDN redirects and cancels redirect bodies', async () => {
    const harness = sessionHarness();
    const redirectCancelled = vi.fn();
    const redirectBody = new ReadableStream<Uint8Array>({ cancel: redirectCancelled });
    const requests: Request[] = [];
    const response = await delivery(harness, async (request) => {
      requests.push(request);
      return requests.length === 1
        ? new Response(redirectBody, { status: 302, headers: { location: REDIRECT_URL } })
        : videoResponse();
    })(input);

    await response.arrayBuffer();
    expect(requests.map((request) => request.url)).toEqual([PRIVATE_URL, REDIRECT_URL]);
    expect(requests.every((request) => request.redirect === 'manual')).toBe(true);
    expect(redirectCancelled).toHaveBeenCalledTimes(1);
  });

  it('does not let a never-settling unsafe redirect cancellation delay lease interruption', async () => {
    const harness = sessionHarness();
    const redirectCancelled = vi.fn(() => new Promise<void>(() => undefined));
    const redirectBody = new ReadableStream<Uint8Array>({ cancel: redirectCancelled });

    await expect(
      delivery(
        harness,
        async () =>
          new Response(redirectBody, {
            status: 302,
            headers: { location: 'https://attacker.test/private' },
          }),
      )(input),
    ).rejects.toMatchObject({ code: 'DOWNLOAD_ORIGIN_INVALID' });
    expect(redirectCancelled).toHaveBeenCalledTimes(1);
    expect(paths(harness).at(-1)).toBe('/interrupt');
    expect(harness.admissionCalls).toEqual(['acquire', 'release']);
  });

  it.each([
    [
      'unsafe redirect',
      () =>
        new Response(null, { status: 302, headers: { location: 'https://attacker.test/private' } }),
    ],
    [
      'unexpected 206',
      () => videoResponse(bytes(4), { status: 206, headers: { 'content-range': 'bytes 0-3/4' } }),
    ],
    [
      'encoded response',
      () => videoResponse(bytes(4), { headers: { 'content-encoding': 'gzip' } }),
    ],
    [
      'wrong media type',
      () => videoResponse(bytes(4), { headers: { 'content-type': 'audio/mp4' } }),
    ],
    [
      'content range on 200',
      () => videoResponse(bytes(4), { headers: { 'content-range': 'bytes 0-3/4' } }),
    ],
    ['validator drift', () => videoResponse(bytes(4), { headers: { etag: '"v2"' } })],
    ['body missing', () => videoResponse(null)],
  ])('fails closed and interrupts after acquire: %s', async (scenario, responseFactory) => {
    const harness = sessionHarness();
    const action = delivery(harness, async () => responseFactory())(input);

    await expect(action).rejects.toBeInstanceOf(DownloadDeliveryError);
    expect(paths(harness).at(-1)).toBe('/interrupt');
    const serialized = JSON.stringify(await action.catch((error: unknown) => error));
    expect(serialized).not.toContain(PRIVATE_URL);
    expect(serialized).not.toContain('token=');
  });

  it('enforces the three-hop redirect limit and releases the acquired lease', async () => {
    const harness = sessionHarness();
    let count = 0;
    await expect(
      delivery(harness, async () => {
        count += 1;
        return new Response(null, {
          status: 302,
          headers: {
            location: `https://edge${String(count)}.cdninstagram.com/video.mp4`,
          },
        });
      })(input),
    ).rejects.toMatchObject({ code: 'DOWNLOAD_ORIGIN_INVALID' });
    expect(count).toBe(4);
    expect(paths(harness).at(-1)).toBe('/interrupt');
  });

  it('rejects a zero-length origin representation during setup', async () => {
    const acquiredMedia = media({
      completionReliable: false,
      contentLength: null,
      lastModified: null,
      rangeCapability: 'unknown',
      strongEtag: null,
      validator: null,
    });
    const harness = sessionHarness({ acquiredMedia });
    const empty = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });

    await expect(
      delivery(
        harness,
        async () =>
          new Response(empty, {
            headers: { 'content-length': '0', 'content-type': 'video/mp4' },
          }),
      )(input),
    ).rejects.toMatchObject({ code: 'DOWNLOAD_ORIGIN_INVALID' });
    expect(paths(harness).at(-1)).toBe('/interrupt');
  });

  it('interrupts the local lease and cancels origin when final admission proof fails', async () => {
    const harness = sessionHarness({
      admissionRenew: async () => {
        throw new Error('admission unavailable');
      },
    });
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel: cancelled });

    await expect(
      delivery(
        harness,
        async () =>
          new Response(body, {
            headers: {
              'content-length': '4',
              'content-type': 'video/mp4',
              etag: '"v1"',
            },
          }),
      )(input),
    ).rejects.toThrow('admission unavailable');
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(1));
    expect(paths(harness)).toEqual(['/inspect', '/acquire', '/interrupt']);
    expect(harness.admissionCalls).toEqual(['acquire', 'renew', 'release']);
  });
});

describe('download delivery stream accounting', () => {
  it('interrupts and errors on short and overlong origin bodies', async () => {
    for (const originBytes of [bytes(3), bytes(5)]) {
      const harness = sessionHarness();
      const response = await delivery(harness, async () => videoResponse(originBytes))(input);
      await expect(response.arrayBuffer()).rejects.toThrow('DOWNLOAD_STREAM_FAILED');
      expect(paths(harness).at(-1)).toBe('/interrupt');
      expect(paths(harness)).not.toContain('/finish');
      expect(harness.admissionCalls).toEqual(['acquire', 'renew', 'release']);
    }
  });

  it('turns an origin reader error into a generic failure and interrupts once', async () => {
    const harness = sessionHarness();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error(`${PRIVATE_URL} private stack`));
      },
    });
    const response = await delivery(harness, async () => videoResponse(body))(input);

    let caught: unknown;
    try {
      await response.arrayBuffer();
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('DOWNLOAD_STREAM_FAILED');
    expect((caught as Error).message).not.toContain(PRIVATE_URL);
    expect(paths(harness).filter((path) => path === '/interrupt')).toHaveLength(1);
    expect(paths(harness)).not.toContain('/finish');
  });

  it('interrupts and errors when an unknown-length origin ends without bytes', async () => {
    const acquiredMedia = media({
      completionReliable: false,
      contentLength: null,
      lastModified: null,
      rangeCapability: 'unknown',
      strongEtag: null,
      validator: null,
    });
    const harness = sessionHarness({ acquiredMedia });
    const empty = chunkStream([]);
    const response = await delivery(
      harness,
      async () => new Response(empty, { headers: { 'content-type': 'video/mp4' } }),
    )(input);

    await expect(response.arrayBuffer()).rejects.toThrow('DOWNLOAD_STREAM_FAILED');
    expect(paths(harness).at(-1)).toBe('/interrupt');
    expect(paths(harness)).not.toContain('/finish');
  });

  it('cancels the single origin reader and best-effort interrupts the lease', async () => {
    const harness = sessionHarness();
    const originCancelled = vi.fn();
    const origin = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.enqueue(bytes(1));
        },
        cancel: originCancelled,
      },
      { highWaterMark: 0 },
    );
    const response = await delivery(harness, async () => videoResponse(origin))(input);
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();

    expect(originCancelled).toHaveBeenCalledTimes(1);
    expect(paths(harness).filter((path) => path === '/interrupt')).toHaveLength(1);
    expect(paths(harness)).not.toContain('/finish');
    expect(harness.admissionCalls).toEqual(['acquire', 'renew', 'release']);
  });

  it('does not wait for a stuck origin cancellation before interrupting the lease', async () => {
    const harness = sessionHarness();
    const originCancellation = deferred<void>();
    const originCancelled = vi.fn(() => originCancellation.promise);
    const origin = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.enqueue(bytes(1));
        },
        cancel: originCancelled,
      },
      { highWaterMark: 0 },
    );
    const response = await delivery(harness, async () => videoResponse(origin))(input);
    const reader = response.body!.getReader();
    await reader.read();

    await expect(reader.cancel()).resolves.toBeUndefined();
    expect(originCancelled).toHaveBeenCalledTimes(1);
    expect(paths(harness).at(-1)).toBe('/interrupt');
    originCancellation.resolve(undefined);
  });

  it('periodically renews a blocked reader with one request in flight and stops on cancel', async () => {
    vi.useFakeTimers();
    try {
      const firstRenewal = deferred<Response>();
      let renewalCount = 0;
      const harness = sessionHarness({
        renew: async (body) => {
          renewalCount += 1;
          if (renewalCount === 1) {
            return firstRenewal.promise;
          }
          return Response.json({
            ok: true,
            holderId,
            sequence: body['sequence'],
            expiresAt: 960_000,
          });
        },
      });
      const blocked = deferred<void>();
      const origin = new ReadableStream<Uint8Array>(
        {
          pull: () => blocked.promise,
        },
        { highWaterMark: 0 },
      );
      const response = await delivery(harness, async () => videoResponse(origin))(input);
      const reader = response.body!.getReader();
      const pendingRead = reader.read();

      await vi.advanceTimersByTimeAsync(30_000);
      expect(paths(harness).filter((path) => path === '/renew')).toHaveLength(1);
      expect(harness.admissionCalls.filter((call) => call === 'renew')).toHaveLength(2);
      expect(callBody(harness, '/renew')['sequence']).toBe(1);
      await vi.advanceTimersByTimeAsync(DOWNLOAD_LIFECYCLE_MUTATION_TIMEOUT_MS - 1_000);
      expect(paths(harness).filter((path) => path === '/renew')).toHaveLength(1);

      firstRenewal.resolve(Response.json({ ok: true, holderId, sequence: 1, expiresAt: 930_000 }));
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(paths(harness).filter((path) => path === '/renew')).toHaveLength(2);
      expect(harness.admissionCalls.filter((call) => call === 'renew')).toHaveLength(3);
      expect(harness.calls.filter((call) => call.path === '/renew').at(-1)!.body).toMatchObject({
        sequence: 2,
      });

      await expect(reader.cancel()).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(paths(harness).filter((path) => path === '/renew')).toHaveLength(2);
      expect(paths(harness).filter((path) => path === '/interrupt')).toHaveLength(1);
      expect(harness.admissionCalls.filter((call) => call === 'release')).toHaveLength(1);
      await expect(pendingRead).resolves.toEqual({ done: true, value: undefined });
      blocked.resolve(undefined);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed after either heartbeat fails and cleans up with the latest acknowledged lease', async () => {
    vi.useFakeTimers();
    try {
      const blocked = deferred<void>();
      let admissionRenewals = 0;
      const harness = sessionHarness({
        admissionRenew: async () => {
          admissionRenewals += 1;
          if (admissionRenewals > 1) {
            throw new Error('admission unavailable');
          }
        },
      });
      const origin = new ReadableStream<Uint8Array>(
        { pull: () => blocked.promise },
        { highWaterMark: 0 },
      );
      const response = await delivery(harness, async () => videoResponse(origin))(input);
      const pendingRead = response.body!.getReader().read();
      const failedRead = expect(pendingRead).rejects.toThrow('DOWNLOAD_STREAM_FAILED');

      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => expect(paths(harness)).toContain('/interrupt'));

      expect(paths(harness).filter((path) => path === '/renew')).toHaveLength(1);
      expect(callBody(harness, '/interrupt')['sequence']).toBe(1);
      expect(harness.admissionCalls).toEqual(['acquire', 'renew', 'renew', 'release']);
      await failedRead;
      blocked.resolve(undefined);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['admission', 'download session'] as const)(
    'bounds a never-settling %s heartbeat and lets cancellation cleanup converge',
    async (stalledLease) => {
      vi.useFakeTimers();
      try {
        const blocked = deferred<void>();
        const neverAdmission = new Promise<void>(() => undefined);
        const neverDownload = new Promise<Response>(() => undefined);
        let admissionRenewals = 0;
        const harness = sessionHarness({
          ...(stalledLease === 'admission'
            ? {
                admissionRenew: () => {
                  admissionRenewals += 1;
                  return admissionRenewals === 1 ? Promise.resolve() : neverAdmission;
                },
              }
            : {
                renew: () => neverDownload,
                interrupt: async (body) =>
                  body['sequence'] === 1
                    ? Response.json({ ok: true })
                    : Response.json({ ok: false }, { status: 409 }),
              }),
        });
        const origin = new ReadableStream<Uint8Array>(
          { pull: () => blocked.promise },
          { highWaterMark: 0 },
        );
        const response = await delivery(harness, async () => videoResponse(origin))(input);
        const pendingRead = response.body!.getReader().read();
        const failedRead = expect(pendingRead).rejects.toThrow('DOWNLOAD_STREAM_FAILED');

        await vi.advanceTimersByTimeAsync(30_000 + DOWNLOAD_LIFECYCLE_MUTATION_TIMEOUT_MS);
        await vi.waitFor(() => expect(paths(harness)).toContain('/interrupt'));

        expect(harness.admissionCalls.filter((call) => call === 'release')).toHaveLength(1);
        expect(
          harness.calls
            .filter((call) => call.path === '/interrupt')
            .map((call) => (call.body as Record<string, unknown>)['sequence']),
        ).toEqual(stalledLease === 'admission' ? [1] : [0, 1]);
        await failedRead;
        blocked.resolve(undefined);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('cancels with the attempted sequence after a download-renew acknowledgement is lost', async () => {
    vi.useFakeTimers();
    try {
      const harness = sessionHarness({
        renew: () => new Promise<Response>(() => undefined),
        interrupt: async (body) =>
          body['sequence'] === 1
            ? Response.json({ ok: true })
            : Response.json({ ok: false }, { status: 409 }),
      });
      const origin = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            controller.enqueue(bytes(1));
          },
        },
        { highWaterMark: 0 },
      );
      const response = await delivery(harness, async () => videoResponse(origin))(input);
      const reader = response.body!.getReader();
      await reader.read();
      await vi.advanceTimersByTimeAsync(30_000);
      const cancellation = reader.cancel();
      let settled = false;
      void cancellation.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(DOWNLOAD_LIFECYCLE_MUTATION_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(cancellation).resolves.toBeUndefined();
      expect(
        harness.calls
          .filter((call) => call.path === '/interrupt')
          .map((call) => (call.body as Record<string, unknown>)['sequence']),
      ).toEqual([0, 1]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('finishes with the attempted sequence after a download-renew acknowledgement is lost', async () => {
    vi.useFakeTimers();
    try {
      const closeOrigin = deferred<void>();
      let sent = false;
      const harness = sessionHarness({
        renew: () => new Promise<Response>(() => undefined),
        finish: async (body) =>
          body['sequence'] === 1
            ? Response.json({ ok: true })
            : Response.json({ ok: false }, { status: 409 }),
      });
      const origin = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            if (!sent) {
              sent = true;
              controller.enqueue(bytes(4));
              return;
            }
            await closeOrigin.promise;
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
      const response = await delivery(harness, async () => videoResponse(origin))(input);
      const reader = response.body!.getReader();
      await expect(reader.read()).resolves.toMatchObject({ done: false });
      await vi.advanceTimersByTimeAsync(30_000);
      const eof = reader.read();
      closeOrigin.resolve(undefined);
      await vi.advanceTimersByTimeAsync(DOWNLOAD_LIFECYCLE_MUTATION_TIMEOUT_MS);

      await expect(eof).resolves.toEqual({ done: true, value: undefined });
      expect(
        harness.calls
          .filter((call) => call.path === '/finish')
          .map((call) => (call.body as Record<string, unknown>)['sequence']),
      ).toEqual([0, 1]);
      expect(paths(harness)).not.toContain('/interrupt');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for the finish acknowledgement before closing the downstream stream', async () => {
    const finish = deferred<Response>();
    const harness = sessionHarness({ finish: async () => finish.promise });
    const response = await delivery(harness, async () => videoResponse())(input);
    const reader = response.body!.getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    const eof = reader.read();
    let closed = false;
    void eof.then(() => {
      closed = true;
    });
    await vi.waitFor(() => expect(paths(harness)).toContain('/finish'));
    expect(closed).toBe(false);

    finish.resolve(Response.json({ ok: true }));
    await expect(eof).resolves.toEqual({ done: true, value: undefined });
    expect(harness.admissionCalls).toEqual(['acquire', 'renew', 'release']);
  });

  it('bounds a never-settling admission release before closing a confirmed EOF', async () => {
    vi.useFakeTimers();
    try {
      const harness = sessionHarness({
        admissionRelease: () => new Promise<void>(() => undefined),
      });
      const response = await delivery(harness, async () => videoResponse())(input);
      const completed = response.arrayBuffer();
      let settled = false;
      void completed.then(() => {
        settled = true;
      });
      await vi.waitFor(() => expect(harness.admissionCalls).toContain('release'));
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(DOWNLOAD_LIFECYCLE_MUTATION_TIMEOUT_MS);
      await expect(completed).resolves.toHaveProperty('byteLength', 4);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a confirmed EOF finish pending when downstream cancels and avoids controller reuse', async () => {
    const finish = deferred<Response>();
    const harness = sessionHarness({ finish: async () => finish.promise });
    const response = await delivery(harness, async () => videoResponse())(input);
    const reader = response.body!.getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    const eof = reader.read();
    await vi.waitFor(() => expect(paths(harness)).toContain('/finish'));

    const cancellation = reader.cancel();
    expect(paths(harness)).not.toContain('/interrupt');
    finish.resolve(Response.json({ ok: true }));

    await expect(cancellation).resolves.toBeUndefined();
    await expect(eof).resolves.toEqual({ done: true, value: undefined });
    expect(paths(harness).filter((path) => path === '/finish')).toHaveLength(1);
    expect(paths(harness)).not.toContain('/interrupt');
  });

  it('errors instead of closing when the finish acknowledgement fails', async () => {
    const harness = sessionHarness({
      finish: async () => Response.json({ ok: false }, { status: 503 }),
    });
    const response = await delivery(harness, async () => videoResponse())(input);

    await expect(response.arrayBuffer()).rejects.toThrow('DOWNLOAD_STREAM_FAILED');
    expect(paths(harness)).toContain('/finish');
    expect(paths(harness)).toContain('/interrupt');
  });

  it('serializes cancel behind an in-flight renewal and interrupts with its acknowledged sequence', async () => {
    vi.useFakeTimers();
    try {
      const renewal = deferred<Response>();
      const harness = sessionHarness({ renew: async () => renewal.promise });
      const origin = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            controller.enqueue(bytes(1));
          },
        },
        { highWaterMark: 0 },
      );
      const response = await delivery(harness, async () => videoResponse(origin))(input);
      const reader = response.body!.getReader();
      await reader.read();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(paths(harness)).toContain('/renew');

      const cancellation = reader.cancel();
      renewal.resolve(Response.json({ ok: true, holderId, sequence: 1, expiresAt: 930_000 }));
      await cancellation;

      expect(paths(harness).filter((path) => path === '/renew')).toHaveLength(1);
      expect(paths(harness).filter((path) => path === '/interrupt')).toHaveLength(1);
      expect(callBody(harness, '/interrupt')['sequence']).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

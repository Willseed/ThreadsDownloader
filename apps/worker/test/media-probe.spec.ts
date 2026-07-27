import { describe, expect, it, vi } from 'vitest';

import {
  createMediaProbe,
  MediaProbeError,
  normalizeProbedMedia,
  type MediaProbeErrorCode,
  type MediaProbeFetch,
} from '../src/resolver/media-probe.js';
import { parseCdnUrl, type CdnUrl } from '../src/security/upstream-policy.js';

const LAST_MODIFIED = 'Mon, 01 Jan 2024 00:00:00 GMT';
const PRIVATE_CANDIDATE =
  'https://video.cdninstagram.com/media/start.mp4?token=private-candidate-token';
const candidate = parseCdnUrl(PRIVATE_CANDIDATE);
const encoder = new TextEncoder();
const insecureHttp = 'http:';

interface TrackedResponse {
  readonly response: Response;
  readonly cancelCalls: () => number;
  readonly pullCalls: () => number;
  readonly readCalls: () => number;
}

function cancellableResponse(
  status: number,
  headers: HeadersInit = {},
  options: { readonly cancelRejectsWith?: string; readonly bodySecret?: string } = {},
): TrackedResponse {
  let pulls = 0;
  const cancel = vi.fn(() =>
    options.cancelRejectsWith === undefined
      ? undefined
      : Promise.reject(new Error(options.cancelRejectsWith)),
  );
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls += 1;
        controller.enqueue(encoder.encode(options.bodySecret ?? 'private upstream body'));
        controller.close();
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  const response = new Response(body, { headers, status });
  const arrayBuffer = vi.spyOn(response, 'arrayBuffer');
  const blob = vi.spyOn(response, 'blob');
  const json = vi.spyOn(response, 'json');
  const text = vi.spyOn(response, 'text');
  return {
    response,
    cancelCalls: () => cancel.mock.calls.length,
    pullCalls: () => pulls,
    readCalls: () =>
      arrayBuffer.mock.calls.length +
      blob.mock.calls.length +
      json.mock.calls.length +
      text.mock.calls.length,
  };
}

function fullVideoHeaders(overrides: HeadersInit = {}): Headers {
  const headers = new Headers({
    'accept-ranges': 'bytes',
    'content-length': '10',
    'content-type': 'video/mp4',
    etag: '"strong-v1"',
    'last-modified': LAST_MODIFIED,
  });
  new Headers(overrides).forEach((value, name) => headers.set(name, value));
  return headers;
}

function partialVideoHeaders(overrides: HeadersInit = {}): Headers {
  const headers = new Headers({
    'content-length': '1',
    'content-range': 'bytes 0-0/42',
    'content-type': 'video/mp4',
    etag: '"strong-v1"',
    'last-modified': LAST_MODIFIED,
  });
  new Headers(overrides).forEach((value, name) => headers.set(name, value));
  return headers;
}

function scriptedFetch(responses: readonly TrackedResponse[]): {
  readonly fetcher: MediaProbeFetch;
  readonly requests: Request[];
} {
  const queue = [...responses];
  const requests: Request[] = [];
  return {
    requests,
    fetcher: vi.fn(async (request: Request) => {
      requests.push(request);
      const next = queue.shift();
      if (next === undefined) {
        throw new Error('unexpected probe fetch');
      }
      return next.response;
    }),
  };
}

function subject(
  fetcher: MediaProbeFetch,
  controller = new AbortController(),
  timeoutCalls: number[] = [],
) {
  return createMediaProbe({
    fetch: fetcher,
    timeoutSignal(milliseconds) {
      timeoutCalls.push(milliseconds);
      return controller.signal;
    },
  });
}

async function expectProbeError(
  action: Promise<unknown>,
  code: MediaProbeErrorCode,
  secrets: readonly string[] = [],
): Promise<void> {
  let caught: unknown;
  try {
    await action;
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(MediaProbeError);
  expect(caught).toMatchObject({ code, message: code });
  for (const secret of secrets) {
    expect((caught as Error).message).not.toContain(secret);
  }
}

function expectCancelledWithoutRead(tracked: TrackedResponse): void {
  expect(tracked.cancelCalls()).toBe(1);
  expect(tracked.pullCalls()).toBe(0);
  expect(tracked.readCalls()).toBe(0);
}

describe('normalizeProbedMedia', () => {
  it('rebuilds derived metadata and rejects an asserted validator mismatch', () => {
    const input = {
      finalUrl: PRIVATE_CANDIDATE,
      contentType: 'video/mp4',
      contentLength: 10,
      rangeCapability: 'bytes',
      strongEtag: '"strong-v1"',
      lastModified: LAST_MODIFIED,
      completionReliable: true,
      probeMethod: 'head',
    } as const;

    expect(normalizeProbedMedia(input)).toEqual({
      ...input,
      finalUrl: candidate,
      validator: { kind: 'etag', value: '"strong-v1"' },
    });
    expect(() =>
      normalizeProbedMedia({
        ...input,
        validator: { kind: 'last-modified', value: LAST_MODIFIED },
      }),
    ).toThrowError(
      expect.objectContaining<Partial<MediaProbeError>>({ code: 'MEDIA_PROBE_METADATA_INVALID' }),
    );
  });
});

describe('MediaProbe HEAD', () => {
  it('uses one timeout and a fresh credential-free fixed HEAD request', async () => {
    const success = cancellableResponse(200, fullVideoHeaders({ 'content-encoding': 'IDENTITY' }));
    const { fetcher, requests } = scriptedFetch([success]);
    const timeoutCalls: number[] = [];
    const controller = new AbortController();

    const result = await subject(fetcher, controller, timeoutCalls).probe(candidate);

    expect(result).toMatchObject({
      contentType: 'video/mp4',
      contentLength: 10,
      rangeCapability: 'bytes',
      strongEtag: '"strong-v1"',
      lastModified: LAST_MODIFIED,
      validator: { kind: 'etag', value: '"strong-v1"' },
      completionReliable: true,
      probeMethod: 'head',
    });
    expect(result.finalUrl.url.href).toBe(PRIVATE_CANDIDATE);
    expect(timeoutCalls).toEqual([8_000]);
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.url).toBe(PRIVATE_CANDIDATE);
    expect(request.method).toBe('HEAD');
    expect(request.redirect).toBe('manual');
    expect(request.credentials).toBe('omit');
    expect(request.referrer).toBe('');
    expect(request.body).toBeNull();
    expect([...request.headers.entries()]).toEqual([
      ['accept', '*/*'],
      ['accept-encoding', 'identity'],
      ['user-agent', 'threads-downloader/0.1'],
    ]);
    for (const forbidden of ['authorization', 'cookie', 'origin', 'range', 'referer']) {
      expect(request.headers.has(forbidden)).toBe(false);
    }
    controller.abort();
    expect(request.signal.aborted).toBe(true);
    expectCancelledWithoutRead(success);
  });

  it('allows a comma inside a quoted Content-Type parameter and ignores cancel rejection', async () => {
    const cancellationSecret = 'private cancellation failure';
    const success = cancellableResponse(
      200,
      fullVideoHeaders({ 'content-type': ' Video/MP4 ; codecs="avc1,mp4a" ' }),
      { cancelRejectsWith: cancellationSecret },
    );
    const { fetcher } = scriptedFetch([success]);

    await expect(subject(fetcher).probe(candidate)).resolves.toMatchObject({
      contentType: 'video/mp4',
      probeMethod: 'head',
    });
    await Promise.resolve();
    expectCancelledWithoutRead(success);
  });

  it.each([
    ['bytes', 'bytes'],
    [' Bytes ', 'bytes'],
    ['none', 'none'],
    ['NONE', 'none'],
    ['items', 'unknown'],
    ['', 'unknown'],
  ] as const)('classifies advertised range support %j as %s', async (value, expected) => {
    const headers = fullVideoHeaders();
    if (value === '') {
      headers.delete('accept-ranges');
    } else {
      headers.set('accept-ranges', value);
    }
    const success = cancellableResponse(200, headers);
    const { fetcher } = scriptedFetch([success]);

    await expect(subject(fetcher).probe(candidate)).resolves.toMatchObject({
      rangeCapability: expected,
    });
    expectCancelledWithoutRead(success);
  });

  it('preserves validator metadata without overstating completion reliability', async () => {
    const unknownLength = cancellableResponse(200, {
      'content-type': 'video/webm',
      etag: '"strong-v2"',
      'last-modified': LAST_MODIFIED,
    });
    const unknownScript = scriptedFetch([unknownLength]);
    await expect(subject(unknownScript.fetcher).probe(candidate)).resolves.toMatchObject({
      contentLength: null,
      strongEtag: '"strong-v2"',
      lastModified: LAST_MODIFIED,
      validator: { kind: 'etag', value: '"strong-v2"' },
      completionReliable: false,
    });

    const lastModified = cancellableResponse(200, {
      'content-length': '10',
      'content-type': 'video/mp4',
      etag: 'W/"weak"',
      'last-modified': LAST_MODIFIED,
    });
    const lastModifiedScript = scriptedFetch([lastModified]);
    await expect(subject(lastModifiedScript.fetcher).probe(candidate)).resolves.toMatchObject({
      strongEtag: null,
      lastModified: LAST_MODIFIED,
      validator: { kind: 'last-modified', value: LAST_MODIFIED },
      completionReliable: true,
    });

    const noValidator = cancellableResponse(200, {
      'content-length': '10',
      'content-type': 'video/mp4',
    });
    const noValidatorScript = scriptedFetch([noValidator]);
    await expect(subject(noValidatorScript.fetcher).probe(candidate)).resolves.toMatchObject({
      validator: null,
      completionReliable: false,
    });

    for (const tracked of [unknownLength, lastModified, noValidator]) {
      expectCancelledWithoutRead(tracked);
    }
  });

  it.each([
    [null, 'MEDIA_PROBE_CONTENT_TYPE_INVALID'],
    ['', 'MEDIA_PROBE_CONTENT_TYPE_INVALID'],
    ['video/', 'MEDIA_PROBE_CONTENT_TYPE_INVALID'],
    ['video/*', 'MEDIA_PROBE_CONTENT_TYPE_INVALID'],
    ['text/html', 'MEDIA_PROBE_CONTENT_TYPE_INVALID'],
    ['application/json', 'MEDIA_PROBE_CONTENT_TYPE_INVALID'],
    ['application/octet-stream', 'MEDIA_PROBE_CONTENT_TYPE_INVALID'],
    ['video/mp4, video/webm', 'MEDIA_PROBE_CONTENT_TYPE_INVALID'],
    ['video/mp4; codecs=avc1, video/webm', 'MEDIA_PROBE_CONTENT_TYPE_INVALID'],
  ] as const)('rejects invalid video Content-Type %j without fallback', async (value, code) => {
    const headers = fullVideoHeaders();
    if (value === null) {
      headers.delete('content-type');
    } else {
      headers.set('content-type', value);
    }
    const invalid = cancellableResponse(200, headers, { bodySecret: 'private invalid mime body' });
    const { fetcher, requests } = scriptedFetch([invalid]);

    await expectProbeError(subject(fetcher).probe(candidate), code, [
      PRIVATE_CANDIDATE,
      'private invalid mime body',
    ]);
    expect(requests).toHaveLength(1);
    expectCancelledWithoutRead(invalid);
  });

  it.each([
    [{ 'content-encoding': 'gzip' }],
    [{ 'content-encoding': 'br' }],
    [{ 'content-encoding': 'identity, gzip' }],
    [{ 'content-length': '0' }],
    [{ 'content-length': '-1' }],
    [{ 'content-length': 'not-a-number' }],
    [{ 'content-length': '1, 1' }],
    [{ 'content-length': '9007199254740992' }],
    [{ 'content-range': 'bytes 0-9/10' }],
  ])('rejects unsafe HEAD representation metadata without fallback', async (override) => {
    const invalid = cancellableResponse(200, fullVideoHeaders(override));
    const { fetcher, requests } = scriptedFetch([invalid]);

    await expectProbeError(subject(fetcher).probe(candidate), 'MEDIA_PROBE_METADATA_INVALID');
    expect(requests).toHaveLength(1);
    expectCancelledWithoutRead(invalid);
  });
});

describe('MediaProbe range fallback', () => {
  it('uses the original candidate for one Range GET after a HEAD transport failure', async () => {
    const networkSecret = 'private HEAD transport failure';
    const partial = cancellableResponse(
      206,
      partialVideoHeaders({ 'content-encoding': 'identity' }),
    );
    const requests: Request[] = [];
    const fetcher = vi.fn(async (request: Request) => {
      requests.push(request);
      if (requests.length === 1) {
        throw new Error(networkSecret);
      }
      return partial.response;
    });
    const timeoutCalls: number[] = [];
    const controller = new AbortController();

    await expect(
      subject(fetcher, controller, timeoutCalls).probe(candidate),
    ).resolves.toMatchObject({
      contentLength: 42,
      rangeCapability: 'bytes',
      completionReliable: true,
      probeMethod: 'range-get',
    });

    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ['HEAD', PRIVATE_CANDIDATE],
      ['GET', PRIVATE_CANDIDATE],
    ]);
    expect([...requests[1]!.headers.entries()]).toEqual([
      ['accept', '*/*'],
      ['accept-encoding', 'identity'],
      ['range', 'bytes=0-0'],
      ['user-agent', 'threads-downloader/0.1'],
    ]);
    expect(timeoutCalls).toEqual([8_000]);
    controller.abort();
    expect(requests.every((request) => request.signal.aborted)).toBe(true);
    expectCancelledWithoutRead(partial);
  });

  it.each([405, 501])('falls back only from HEAD %i to an exact one-byte GET', async (status) => {
    const unsupportedHead = cancellableResponse(status, {
      'content-encoding': 'gzip',
      'content-length': 'not-a-number',
      'content-type': 'text/html',
    });
    const partial = cancellableResponse(
      206,
      partialVideoHeaders({ 'content-encoding': 'identity' }),
    );
    const { fetcher, requests } = scriptedFetch([unsupportedHead, partial]);
    const timeoutCalls: number[] = [];
    const controller = new AbortController();

    const result = await subject(fetcher, controller, timeoutCalls).probe(candidate);

    expect(result).toMatchObject({
      contentLength: 42,
      rangeCapability: 'bytes',
      strongEtag: '"strong-v1"',
      lastModified: LAST_MODIFIED,
      completionReliable: true,
      probeMethod: 'range-get',
    });
    expect(requests.map((request) => request.method)).toEqual(['HEAD', 'GET']);
    expect(requests[0]!.headers.has('range')).toBe(false);
    expect(requests[1]!.headers.get('range')).toBe('bytes=0-0');
    expect(requests[1]!.headers.get('accept-encoding')).toBe('identity');
    expect(timeoutCalls).toEqual([8_000]);
    controller.abort();
    expect(requests.every((request) => request.signal.aborted)).toBe(true);
    expectCancelledWithoutRead(unsupportedHead);
    expectCancelledWithoutRead(partial);
  });

  it('accepts a 200 that ignored Range, marks ranges unsupported, and cancels immediately', async () => {
    const unsupportedHead = cancellableResponse(405);
    const full = cancellableResponse(
      200,
      fullVideoHeaders({ 'accept-ranges': 'bytes', 'content-length': '128' }),
      { bodySecret: 'private full video bytes' },
    );
    const { fetcher } = scriptedFetch([unsupportedHead, full]);

    await expect(subject(fetcher).probe(candidate)).resolves.toMatchObject({
      contentLength: 128,
      rangeCapability: 'none',
      probeMethod: 'range-get',
    });
    expectCancelledWithoutRead(unsupportedHead);
    expectCancelledWithoutRead(full);
  });

  it.each([206, 400, 404, 429, 500])('does not fallback from terminal HEAD %i', async (status) => {
    const terminal = cancellableResponse(status, partialVideoHeaders());
    const { fetcher, requests } = scriptedFetch([terminal]);

    await expectProbeError(subject(fetcher).probe(candidate), 'MEDIA_PROBE_STATUS_INVALID', [
      String(status),
    ]);
    expect(requests).toHaveLength(1);
    expectCancelledWithoutRead(terminal);
  });

  it('does not fallback after abort or timeout-factory failures', async () => {
    const abortSecret = 'private abort reason';
    const abortFetch = vi.fn(async () => {
      throw new DOMException(abortSecret, 'AbortError');
    });
    await expectProbeError(subject(abortFetch).probe(candidate), 'MEDIA_PROBE_ABORTED', [
      abortSecret,
    ]);
    expect(abortFetch).toHaveBeenCalledTimes(1);

    const preAborted = new AbortController();
    preAborted.abort('private pre-abort reason');
    const skippedFetch = vi.fn<MediaProbeFetch>();
    await expectProbeError(
      subject(skippedFetch, preAborted).probe(candidate),
      'MEDIA_PROBE_ABORTED',
    );
    expect(skippedFetch).not.toHaveBeenCalled();

    const timeoutFetch = vi.fn<MediaProbeFetch>();
    const timeoutSubject = createMediaProbe({
      fetch: timeoutFetch,
      timeoutSignal() {
        throw new Error('private timer failure');
      },
    });
    await expectProbeError(timeoutSubject.probe(candidate), 'MEDIA_PROBE_UNAVAILABLE', [
      'private timer failure',
    ]);
    expect(timeoutFetch).not.toHaveBeenCalled();
  });

  it('maps transport and terminal status failures from the transport fallback', async () => {
    const rangeSecret = 'private Range transport failure';
    const transportFetch = vi
      .fn<MediaProbeFetch>()
      .mockRejectedValueOnce(new Error('private HEAD transport failure'))
      .mockRejectedValueOnce(new Error(rangeSecret));
    await expectProbeError(subject(transportFetch).probe(candidate), 'MEDIA_PROBE_UNAVAILABLE', [
      rangeSecret,
      PRIVATE_CANDIDATE,
    ]);
    expect(transportFetch).toHaveBeenCalledTimes(2);

    const invalid = cancellableResponse(500, { 'content-type': 'text/html' });
    const invalidFetch = vi
      .fn<MediaProbeFetch>()
      .mockRejectedValueOnce(new Error('private HEAD transport failure'))
      .mockResolvedValueOnce(invalid.response);
    await expectProbeError(subject(invalidFetch).probe(candidate), 'MEDIA_PROBE_STATUS_INVALID', [
      PRIVATE_CANDIDATE,
    ]);
    expect(invalidFetch).toHaveBeenCalledTimes(2);
    expectCancelledWithoutRead(invalid);
  });

  it.each([
    {},
    { 'content-range': 'bytes 0-1/42' },
    { 'content-range': 'bytes 1-1/42' },
    { 'content-range': 'bytes */42' },
    { 'content-range': 'bytes 0-0/*' },
    { 'content-range': 'bytes 0-0/0' },
    { 'content-range': 'bytes 0-0/9007199254740992' },
    { 'content-range': 'bytes 0-0/42', 'content-length': '0' },
    { 'content-range': 'bytes 0-0/42', 'content-length': '2' },
  ] as Record<string, string>[])(
    'rejects inconsistent one-byte GET metadata',
    async (rangeHeaders) => {
      const unsupportedHead = cancellableResponse(501);
      const headers = new Headers({ 'content-type': 'video/mp4', etag: '"strong-v1"' });
      new Headers(rangeHeaders).forEach((value, name) => headers.set(name, value));
      const invalid = cancellableResponse(206, headers);
      const { fetcher } = scriptedFetch([unsupportedHead, invalid]);

      await expectProbeError(subject(fetcher).probe(candidate), 'MEDIA_PROBE_METADATA_INVALID');
      expectCancelledWithoutRead(unsupportedHead);
      expectCancelledWithoutRead(invalid);
    },
  );

  it('rejects Content-Range on a fallback 200 and encoded fallback media', async () => {
    for (const override of [
      { 'content-range': 'bytes 0-9/10' },
      { 'content-encoding': 'gzip' },
    ] as Record<string, string>[]) {
      const unsupportedHead = cancellableResponse(405);
      const invalid = cancellableResponse(200, fullVideoHeaders(override));
      const { fetcher } = scriptedFetch([unsupportedHead, invalid]);

      await expectProbeError(subject(fetcher).probe(candidate), 'MEDIA_PROBE_METADATA_INVALID');
      expectCancelledWithoutRead(unsupportedHead);
      expectCancelledWithoutRead(invalid);
    }
  });
});

describe('MediaProbe redirects and URL policy', () => {
  it('follows three relative HEAD redirects and rejects the fourth', async () => {
    const allowedRedirects = Array.from({ length: 3 }, (_, index) =>
      cancellableResponse(302, { location: `/media/head-${String(index)}.mp4?sig=private` }),
    );
    const success = cancellableResponse(200, fullVideoHeaders());
    const allowedScript = scriptedFetch([...allowedRedirects, success]);

    await expect(subject(allowedScript.fetcher).probe(candidate)).resolves.toHaveProperty(
      'probeMethod',
      'head',
    );
    expect(allowedScript.requests.map((request) => request.method)).toEqual([
      'HEAD',
      'HEAD',
      'HEAD',
      'HEAD',
    ]);
    expect(allowedScript.requests.at(-1)?.url).toContain('/media/head-2.mp4');
    for (const tracked of [...allowedRedirects, success]) {
      expectCancelledWithoutRead(tracked);
    }

    const deniedRedirects = Array.from({ length: 4 }, (_, index) =>
      cancellableResponse(302, { location: `/media/denied-${String(index)}.mp4?sig=private` }),
    );
    const deniedScript = scriptedFetch(deniedRedirects);
    await expectProbeError(
      subject(deniedScript.fetcher).probe(candidate),
      'MEDIA_PROBE_REDIRECT_LIMIT',
      ['private-candidate-token', 'sig=private'],
    );
    expect(deniedScript.requests).toHaveLength(4);
    for (const tracked of deniedRedirects) {
      expectCancelledWithoutRead(tracked);
    }
  });

  it.each([
    [undefined, 'missing-location'],
    ['https://attacker.example/video.mp4?secret=host', 'secret=host'],
    [`${insecureHttp}//cdninstagram.com/video.mp4?secret=scheme`, 'secret=scheme'],
  ])('rejects redirect target %j and cancels its body', async (location, secret) => {
    const headers = new Headers();
    if (location !== undefined) {
      headers.set('location', location);
    }
    const redirect = cancellableResponse(302, headers, { bodySecret: 'private redirect body' });
    const { fetcher, requests } = scriptedFetch([redirect]);

    await expectProbeError(subject(fetcher).probe(candidate), 'MEDIA_PROBE_REDIRECT_INVALID', [
      secret,
      'private redirect body',
    ]);
    expect(requests).toHaveLength(1);
    expectCancelledWithoutRead(redirect);
  });

  it('shares one three-hop redirect budget across HEAD and fallback GET', async () => {
    const sequence = [
      cancellableResponse(302, { location: '/media/head-one.mp4' }),
      cancellableResponse(307, { location: '/media/head-two.mp4' }),
      cancellableResponse(405),
      cancellableResponse(303, { location: '/media/get-one.mp4' }),
      cancellableResponse(206, partialVideoHeaders()),
    ];
    const script = scriptedFetch(sequence);
    const timeoutCalls: number[] = [];
    const controller = new AbortController();

    await expect(
      subject(script.fetcher, controller, timeoutCalls).probe(candidate),
    ).resolves.toHaveProperty('rangeCapability', 'bytes');
    expect(script.requests.map((request) => request.method)).toEqual([
      'HEAD',
      'HEAD',
      'HEAD',
      'GET',
      'GET',
    ]);
    expect(timeoutCalls).toEqual([8_000]);
    controller.abort();
    expect(script.requests.every((request) => request.signal.aborted)).toBe(true);
    for (const tracked of sequence) {
      expectCancelledWithoutRead(tracked);
    }

    const denied = [
      cancellableResponse(302, { location: '/media/denied-head-one.mp4' }),
      cancellableResponse(302, { location: '/media/denied-head-two.mp4' }),
      cancellableResponse(405),
      cancellableResponse(302, { location: '/media/denied-get-one.mp4' }),
      cancellableResponse(302, { location: '/media/denied-get-two.mp4?secret=fourth' }),
    ];
    const deniedScript = scriptedFetch(denied);
    await expectProbeError(
      subject(deniedScript.fetcher).probe(candidate),
      'MEDIA_PROBE_REDIRECT_LIMIT',
      ['secret=fourth'],
    );
    expect(deniedScript.requests).toHaveLength(5);
    for (const tracked of denied) {
      expectCancelledWithoutRead(tracked);
    }
  });

  it('revalidates structurally forged and subsequently mutated CDN URLs before fetching', async () => {
    const forgedSecret = 'private-forged-query';
    const forged = {
      url: new URL(`https://attacker.example/video.mp4?token=${forgedSecret}`),
    } as CdnUrl;
    const forgedFetch = vi.fn<MediaProbeFetch>();
    const forgedTimeouts: number[] = [];
    await expectProbeError(
      subject(forgedFetch, new AbortController(), forgedTimeouts).probe(forged),
      'MEDIA_PROBE_CANDIDATE_INVALID',
      [forgedSecret],
    );
    expect(forgedFetch).not.toHaveBeenCalled();
    expect(forgedTimeouts).toEqual([]);

    const mutated = parseCdnUrl('https://video.cdninstagram.com/media/valid.mp4');
    mutated.url.hostname = 'attacker.example';
    const mutatedFetch = vi.fn<MediaProbeFetch>();
    await expectProbeError(subject(mutatedFetch).probe(mutated), 'MEDIA_PROBE_CANDIDATE_INVALID');
    expect(mutatedFetch).not.toHaveBeenCalled();
  });
});

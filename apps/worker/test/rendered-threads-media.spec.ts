import { describe, expect, it, vi } from 'vitest';

import {
  createRenderedThreadsMediaResolver,
  RENDERED_ALLOWED_REQUEST_PATTERNS,
  RENDERED_RESPONSE_READ_TIMEOUT_MS,
  RenderedThreadsMediaResolverError,
  type BrowserRunScrapePort,
  type RenderedBrowserScrapeOptions,
  type RenderedThreadsMediaResolverErrorCode,
} from '../src/resolver/rendered-threads-media.js';
import { parseThreadsPostUrl } from '../src/security/upstream-policy.js';

const MARKER = 'M'.repeat(22);
const insecureHttp = 'http:';
const TARGET_URL = 'https://www.threads.com/@hitostartup.tw/post/DbPp-bqiQEB/media';
const markerSelector = (marker = MARKER): string =>
  `[data-threads-downloader-render-marker="${marker}"]`;
const videoSelector = (marker = MARKER): string => `video[src]${markerSelector(marker)}`;
const sourceSelector = (marker = MARKER): string => `video source[src]${markerSelector(marker)}`;
const currentSelector = (marker = MARKER): string =>
  `video[data-threads-downloader-current-src]${markerSelector(marker)}`;
const selectors = (marker = MARKER) => ({
  video: videoSelector(marker),
  source: sourceSelector(marker),
  current: currentSelector(marker),
});
const PRIVATE_URL =
  'https://instagram.ftpe7-2.fna.fbcdn.net/media/video.mp4?token=private-render-token';
const post = parseThreadsPostUrl(
  'https://www.threads.com/@hitostartup.tw/post/DbPp-bqiQEB?xmt=private-input-token',
);

function element(
  attributes: readonly { readonly name: string; readonly value: string }[],
  provenance: {
    readonly location?: string | null;
    readonly marker?: string | null;
  } = {},
) {
  const marker = provenance.marker === undefined ? MARKER : provenance.marker;
  const location = provenance.location === undefined ? TARGET_URL : provenance.location;
  return {
    html: '<video></video>',
    text: '',
    width: 640,
    height: 360,
    top: 0,
    left: 0,
    attributes: [
      ...attributes,
      ...(marker === null
        ? []
        : [{ name: 'data-threads-downloader-render-marker', value: marker }]),
      ...(location === null
        ? []
        : [{ name: 'data-threads-downloader-render-location', value: location }]),
    ],
  };
}

function successBody(
  videoResults: readonly unknown[] = [],
  sourceResults: readonly unknown[] = [],
  currentResults: readonly unknown[] = [],
  targets = selectors(),
): Record<string, unknown> {
  return {
    success: true,
    result: [
      { selector: targets.video, results: videoResults },
      { selector: targets.source, results: sourceResults },
      { selector: targets.current, results: currentResults },
    ],
  };
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(value), { ...init, headers });
}

function browserReturning(
  response: (options: RenderedBrowserScrapeOptions) => Response | Promise<Response>,
  calls: Array<{ readonly action: string; readonly options: RenderedBrowserScrapeOptions }> = [],
): BrowserRunScrapePort {
  return {
    async quickAction(action, options) {
      calls.push({ action, options });
      return response(options);
    },
  };
}

function resolver(
  browser: BrowserRunScrapePort,
  marker: () => string = () => MARKER,
  timeoutSignal?: (milliseconds: number) => AbortSignal,
) {
  return createRenderedThreadsMediaResolver({
    browser,
    marker,
    ...(timeoutSignal === undefined ? {} : { timeoutSignal }),
  });
}

async function expectResolverError(
  action: Promise<unknown>,
  code: RenderedThreadsMediaResolverErrorCode,
  secrets: readonly string[] = [],
): Promise<void> {
  let caught: unknown;
  try {
    await action;
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RenderedThreadsMediaResolverError);
  expect(caught).toMatchObject({ code, message: code });
  for (const secret of secrets) {
    expect((caught as Error).message).not.toContain(secret);
  }
}

describe('rendered Threads media resolver request policy', () => {
  it('loads only the canonical /media route with bounded credential-free scrape options', async () => {
    const calls: Array<{
      readonly action: string;
      readonly options: RenderedBrowserScrapeOptions;
    }> = [];
    const browser = browserReturning(
      () => jsonResponse(successBody([element([{ name: 'src', value: PRIVATE_URL }])])),
      calls,
    );

    const result = await resolver(browser).resolve(post);

    expect(result.candidates).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.action).toBe('scrape');
    const options = calls[0]!.options;
    expect(options.url).toBe(TARGET_URL);
    expect(options.url).not.toContain('xmt');
    expect(options.cookies).toEqual([]);
    expect(options.cacheTTL).toBe(0);
    expect(options.setJavaScriptEnabled).toBe(true);
    expect(options.gotoOptions).toEqual({ timeout: 4_000, waitUntil: 'domcontentloaded' });
    expect(options.actionTimeout).toBe(6_000);
    expect(options.waitForSelector).toEqual({ selector: 'video', visible: true, timeout: 5_000 });
    expect(options.waitForTimeout).toBe(250);
    expect(options.bestAttempt).toBe(false);
    expect(options.addScriptTag).toHaveLength(1);
    const bridgeScript = options.addScriptTag[0]!.content;
    expect(options.elements).toEqual([
      { selector: videoSelector() },
      { selector: sourceSelector() },
      { selector: currentSelector() },
    ]);
    expect(Object.keys(options).sort()).toEqual([
      'actionTimeout',
      'addScriptTag',
      'allowRequestPattern',
      'bestAttempt',
      'cacheTTL',
      'cookies',
      'elements',
      'gotoOptions',
      'setJavaScriptEnabled',
      'url',
      'waitForSelector',
      'waitForTimeout',
    ]);
    expect(bridgeScript).toContain('video.currentSrc');
    expect(bridgeScript).toContain('data-threads-downloader-current-src');
    expect(bridgeScript).toContain('data-threads-downloader-render-location');
    expect(bridgeScript).toContain('location.href');
    expect(bridgeScript).toContain('removeAttribute(currentSrcAttribute)');
    expect(bridgeScript).toContain(MARKER);
    expect(bridgeScript).not.toContain('private');
  });

  it('anchors Browser Run subrequests to Threads and the two approved CDN families', () => {
    const patterns = RENDERED_ALLOWED_REQUEST_PATTERNS.map((source) => new RegExp(source, 'u'));
    const allowed = (url: string): boolean => patterns.some((pattern) => pattern.test(url));

    expect(allowed('https://www.threads.com/@alice/post/Abcde/media')).toBe(true);
    expect(allowed('https://static.cdninstagram.com/rsrc/script.js')).toBe(true);
    expect(allowed(PRIVATE_URL)).toBe(true);

    for (const unsafe of [
      'https://threads.com/@alice/post/Abcde/media',
      'https://www.threads.com.attacker.example/private',
      'https://user@www.threads.com/private',
      'https://www.threads.com:444/private',
      `${insecureHttp}//www.threads.com/@alice/post/Abcde/media`,
      'https://cdninstagram.com.attacker.example/private',
      'https://instagram.ftpe7-2.fna.fbcdn.net.attacker.example/private',
      'https://scontent.ftpe7-2.fna.fbcdn.net/private',
    ]) {
      expect(allowed(unsafe), unsafe).toBe(false);
    }
  });

  it('creates a fresh secure bridge marker for every resolve call', async () => {
    const calls: Array<{
      readonly action: string;
      readonly options: RenderedBrowserScrapeOptions;
    }> = [];
    const browser = browserReturning((options) => {
      const marker = /data-threads-downloader-render-marker="([A-Za-z0-9_-]{22})"/u.exec(
        options.elements[0]!.selector,
      )?.[1];
      if (marker === undefined) {
        throw new Error('expected a bounded bridge marker');
      }
      return jsonResponse(
        successBody([element([{ name: 'src', value: PRIVATE_URL }], { marker })], [], [], {
          video: options.elements[0]!.selector,
          source: options.elements[1]!.selector,
          current: options.elements[2]!.selector,
        }),
      );
    }, calls);
    const subject = createRenderedThreadsMediaResolver({ browser });

    await subject.resolve(post);
    await subject.resolve(post);

    const selectors = calls.map(({ options }) => options.elements[2]!.selector);
    expect(selectors[0]).toMatch(
      /^video\[data-threads-downloader-current-src\]\[data-threads-downloader-render-marker="[A-Za-z0-9_-]{22}"\]$/u,
    );
    expect(selectors[1]).not.toBe(selectors[0]);
  });
});

describe('rendered Threads media resolver response contract', () => {
  it('bridges currentSrc, ignores unsafe attributes, and canonically deduplicates one candidate', async () => {
    const body = successBody(
      [element([{ name: 'src', value: ` ${PRIVATE_URL} ` }])],
      [
        element([{ name: 'src', value: PRIVATE_URL }]),
        element([{ name: 'src', value: 'https://attacker.example/private' }]),
      ],
      [
        element([
          { name: 'src', value: 'blob:https://www.threads.com/private' },
          { name: 'data-threads-downloader-current-src', value: PRIVATE_URL },
        ]),
      ],
    );

    const result = await resolver(browserReturning(() => jsonResponse(body))).resolve(post);

    expect(result.candidates.map(({ source, value }) => [source, value.url.href])).toEqual([
      ['rendered-video', PRIVATE_URL],
    ]);
  });

  it('accepts currentSrc only through the dedicated bridge attribute', async () => {
    const result = await resolver(
      browserReturning(() =>
        jsonResponse(
          successBody(
            [],
            [],
            [element([{ name: 'data-threads-downloader-current-src', value: PRIVATE_URL }])],
          ),
        ),
      ),
    ).resolve(post);

    expect(result.candidates.map(({ source, value }) => [source, value.url.href])).toEqual([
      ['rendered-current-src', PRIVATE_URL],
    ]);
  });

  it.each([
    ['missing', null],
    ['foreign', 'F'.repeat(22)],
  ] as const)(
    'rejects a %s bridge marker on an alleged currentSrc result',
    async (_name, marker) => {
      const body = successBody(
        [],
        [],
        [
          element([{ name: 'data-threads-downloader-current-src', value: PRIVATE_URL }], {
            marker,
          }),
        ],
      );
      await expectResolverError(
        resolver(browserReturning(() => jsonResponse(body))).resolve(post),
        'RENDERED_RESPONSE_INVALID',
        [PRIVATE_URL],
      );
    },
  );

  it.each([
    ['missing final location', null],
    ['same-host redirect location', 'https://www.threads.com/@hitostartup.tw/post/Related/media'],
    ['target location with a query', `${TARGET_URL}?redirected=private`],
  ] as const)('rejects a candidate stamped with %s', async (_name, location) => {
    const body = successBody([element([{ name: 'src', value: PRIVATE_URL }], { location })]);
    await expectResolverError(
      resolver(browserReturning(() => jsonResponse(body))).resolve(post),
      'RENDERED_RESPONSE_INVALID',
      ['Related', 'redirected=private', PRIVATE_URL],
    );
  });

  it('rejects a malformed marker before calling Browser Run', async () => {
    const quickAction = vi.fn<BrowserRunScrapePort['quickAction']>();
    await expectResolverError(
      createRenderedThreadsMediaResolver({
        browser: { quickAction },
        marker: () => 'private-invalid-marker!',
      }).resolve(post),
      'RENDERED_UNAVAILABLE',
      ['private-invalid-marker!'],
    );
    expect(quickAction).not.toHaveBeenCalled();
  });

  it.each([
    ['extra envelope field', { ...successBody(), provider: 'private-provider-detail' }],
    ['provider error shape', { success: false, errors: [{ message: 'private-provider-detail' }] }],
    [
      'wrong selector order',
      {
        success: true,
        result: [
          { selector: sourceSelector(), results: [] },
          { selector: videoSelector(), results: [] },
          { selector: currentSelector(), results: [] },
        ],
      },
    ],
    ['extra element field', successBody([{ ...element([]), provider: 'private-provider-detail' }])],
    [
      'duplicate attributes',
      successBody([
        element([
          { name: 'src', value: PRIVATE_URL },
          { name: 'src', value: 'https://video.cdninstagram.com/duplicate.mp4' },
        ]),
      ]),
    ],
    [
      'non-finite layout',
      successBody([{ ...element([{ name: 'src', value: PRIVATE_URL }]), width: Number.NaN }]),
    ],
    ['too many selector results', successBody(Array.from({ length: 17 }, () => element([])))],
    [
      'too many attributes',
      successBody([
        element(
          Array.from({ length: 65 }, (_, index) => ({
            name: `data-${String(index)}`,
            value: '',
          })),
        ),
      ]),
    ],
  ] as const)('rejects an invalid exact response: %s', async (_name, body) => {
    await expectResolverError(
      resolver(browserReturning(() => jsonResponse(body))).resolve(post),
      'RENDERED_RESPONSE_INVALID',
      ['private-provider-detail', PRIVATE_URL],
    );
  });

  it('fails closed on multiple unique videos instead of guessing post provenance', async () => {
    const results = Array.from({ length: 2 }, (_, index) =>
      element([
        {
          name: 'src',
          value: `https://video.cdninstagram.com/${String(index)}.mp4?token=private-${String(index)}`,
        },
      ]),
    );
    await expectResolverError(
      resolver(browserReturning(() => jsonResponse(successBody(results)))).resolve(post),
      'RENDERED_RESPONSE_INVALID',
      ['private-1'],
    );
  });

  it.each([
    [
      new Response('{}', { status: 429, headers: { 'content-type': 'application/json' } }),
      'RENDERED_UNAVAILABLE',
    ],
    [new Response('{}'), 'RENDERED_RESPONSE_INVALID'],
    [new Response('{}', { headers: { 'content-type': 'text/html' } }), 'RENDERED_RESPONSE_INVALID'],
    [
      new Response('{broken', { headers: { 'content-type': 'application/json' } }),
      'RENDERED_RESPONSE_INVALID',
    ],
    [
      new Response(Uint8Array.of(0xff), { headers: { 'content-type': 'application/json' } }),
      'RENDERED_RESPONSE_INVALID',
    ],
  ] as const)(
    'maps status, media type, JSON, and UTF-8 failures safely',
    async (response, code) => {
      await expectResolverError(resolver(browserReturning(() => response)).resolve(post), code, [
        'private-provider-detail',
      ]);
    },
  );

  it('prechecks declared length and cancels an actual body beyond 128 KiB', async () => {
    let declaredCancellations = 0;
    const unread = new ReadableStream<Uint8Array>({
      cancel() {
        declaredCancellations += 1;
      },
    });
    const declared = new Response(unread, {
      headers: {
        'content-length': String(128 * 1024 + 1),
        'content-type': 'application/json',
      },
    });
    await expectResolverError(
      resolver(browserReturning(() => declared)).resolve(post),
      'RENDERED_RESPONSE_TOO_LARGE',
    );
    expect(declaredCancellations).toBe(1);

    let actualCancellations = 0;
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(128 * 1024 + 1));
      },
      cancel() {
        actualCancellations += 1;
      },
    });
    await expectResolverError(
      resolver(
        browserReturning(
          () => new Response(oversized, { headers: { 'content-type': 'application/json' } }),
        ),
      ).resolve(post),
      'RENDERED_RESPONSE_TOO_LARGE',
    );
    expect(actualCancellations).toBe(1);
  });

  it('maps binding and body-read failures without provider details', async () => {
    const bindingSecret = 'private-binding-stack';
    await expectResolverError(
      resolver({
        async quickAction() {
          throw new Error(bindingSecret);
        },
      }).resolve(post),
      'RENDERED_UNAVAILABLE',
      [bindingSecret],
    );

    const readSecret = 'private-stream-stack';
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error(readSecret);
      },
    });
    await expectResolverError(
      resolver(
        browserReturning(
          () => new Response(stream, { headers: { 'content-type': 'application/json' } }),
        ),
      ).resolve(post),
      'RENDERED_UNAVAILABLE',
      [readSecret],
    );
  });

  it('aborts and cancels a never-ending response body at one absolute deadline', async () => {
    const controller = new AbortController();
    const timeoutCalls: number[] = [];
    let cancellations = 0;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancellations += 1;
      },
    });
    const action = resolver(
      browserReturning(
        () => new Response(stream, { headers: { 'content-type': 'application/json' } }),
      ),
      () => MARKER,
      (milliseconds) => {
        timeoutCalls.push(milliseconds);
        return controller.signal;
      },
    ).resolve(post);

    await vi.waitFor(() => expect(timeoutCalls).toEqual([RENDERED_RESPONSE_READ_TIMEOUT_MS]));
    controller.abort('private-timeout-reason');
    await expectResolverError(action, 'RENDERED_UNAVAILABLE', ['private-timeout-reason']);
    expect(cancellations).toBe(1);
    await Promise.resolve();
  });

  it('reports no media only after a valid empty response', async () => {
    const browser = browserReturning(() => jsonResponse(successBody()));
    await expectResolverError(resolver(browser).resolve(post), 'RENDERED_MEDIA_NOT_FOUND');
  });

  it('never uses Response.json() for the external Browser Run response', async () => {
    const response = jsonResponse(successBody([element([{ name: 'src', value: PRIVATE_URL }])]));
    const json = vi.spyOn(response, 'json');
    await resolver(browserReturning(() => response)).resolve(post);
    expect(json).not.toHaveBeenCalled();
  });
});

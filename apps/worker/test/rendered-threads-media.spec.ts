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

const insecureHttp = 'http:';
const CANONICAL_URL = 'https://www.threads.com/@alice/post/Abcde';
const USERNAME_REDACTED_URL = 'https://www.threads.com/@/post/Abcde';
const TARGET_URL = 'https://www.threads.com/@alice/post/Abcde/media';
const CANONICAL_SELECTOR = 'link[rel="canonical"]';
const OPEN_GRAPH_SELECTOR = 'meta[property="og:url"]';
const VIDEO_SELECTOR = 'video[src]';
const SOURCE_SELECTOR = 'video source[src]';
const PRIVATE_URL =
  'https://instagram.ftpe7-2.fna.fbcdn.net/media/video.mp4?token=private-render-token';
const post = parseThreadsPostUrl('https://www.threads.com/@alice/post/Abcde?fixture=input');

function element(attributes: readonly { readonly name: string; readonly value: string }[]) {
  return {
    html: '<video></video>',
    text: '',
    width: 640,
    height: 360,
    top: 0,
    left: 0,
    attributes,
  };
}

function successBody(
  videoResults: readonly unknown[] = [],
  sourceResults: readonly unknown[] = [],
  canonicalResults: readonly unknown[] = [element([{ name: 'href', value: CANONICAL_URL }])],
  openGraphResults: readonly unknown[] = [element([{ name: 'content', value: CANONICAL_URL }])],
): Record<string, unknown> {
  return {
    success: true,
    result: [
      { selector: CANONICAL_SELECTOR, results: canonicalResults },
      { selector: OPEN_GRAPH_SELECTOR, results: openGraphResults },
      { selector: VIDEO_SELECTOR, results: videoResults },
      { selector: SOURCE_SELECTOR, results: sourceResults },
    ],
  };
}

function identityBody(value: string): Record<string, unknown> {
  return successBody(
    [],
    [],
    [element([{ name: 'href', value }])],
    [element([{ name: 'content', value }])],
  );
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
  timeoutSignal?: (milliseconds: number) => AbortSignal,
) {
  return createRenderedThreadsMediaResolver({
    browser,
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
    expect(options.url).not.toContain('fixture');
    expect(options.cookies).toEqual([]);
    expect(options.cacheTTL).toBe(0);
    expect(options.setJavaScriptEnabled).toBe(true);
    expect(options.gotoOptions).toEqual({ timeout: 4_000, waitUntil: 'domcontentloaded' });
    expect(options.actionTimeout).toBe(6_000);
    expect(options.waitForSelector).toEqual({
      selector: VIDEO_SELECTOR,
      visible: true,
      timeout: 5_000,
    });
    expect(options.waitForTimeout).toBe(250);
    expect(options.bestAttempt).toBe(false);
    expect(options.elements).toEqual([
      { selector: CANONICAL_SELECTOR },
      { selector: OPEN_GRAPH_SELECTOR },
      { selector: VIDEO_SELECTOR },
      { selector: SOURCE_SELECTOR },
    ]);
    expect(Object.keys(options).sort()).toEqual([
      'actionTimeout',
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
});

describe('rendered Threads media resolver response contract', () => {
  it('validates post identity, ignores unsafe media, and canonically deduplicates one candidate', async () => {
    const body = successBody(
      [element([{ name: 'src', value: ` ${PRIVATE_URL} ` }])],
      [
        element([{ name: 'src', value: PRIVATE_URL }]),
        element([{ name: 'src', value: 'https://attacker.example/private' }]),
      ],
    );

    const result = await resolver(browserReturning(() => jsonResponse(body))).resolve(post);

    expect(result.candidates.map(({ source, value }) => [source, value.url.href])).toEqual([
      ['rendered-video', PRIVATE_URL],
    ]);
  });

  it('accepts one mutually consistent username-redacted identity for the exact shortcode', async () => {
    const body = successBody(
      [element([{ name: 'src', value: PRIVATE_URL }])],
      [],
      [element([{ name: 'href', value: USERNAME_REDACTED_URL }])],
      [element([{ name: 'content', value: USERNAME_REDACTED_URL }])],
    );

    await expect(
      resolver(browserReturning(() => jsonResponse(body))).resolve(post),
    ).resolves.toHaveProperty('candidates.length', 1);
  });

  it.each([
    ['missing canonical link', successBody([], [], [])],
    [
      'duplicate canonical links',
      successBody(
        [],
        [],
        [
          element([{ name: 'href', value: CANONICAL_URL }]),
          element([{ name: 'href', value: CANONICAL_URL }]),
        ],
      ),
    ],
    [
      'canonical link without href',
      successBody([], [], [element([{ name: 'rel', value: 'canonical' }])]),
    ],
    [
      'foreign canonical link',
      successBody(
        [],
        [],
        [
          element([
            {
              name: 'href',
              value: 'https://www.threads.com/@alice/post/Related',
            },
          ]),
        ],
      ),
    ],
    ['missing Open Graph URL', successBody([], [], undefined, [])],
    [
      'Open Graph URL with query',
      successBody([], [], undefined, [
        element([{ name: 'content', value: `${CANONICAL_URL}?private=redirected` }]),
      ]),
    ],
    [
      'redacted identity with a mismatched shortcode',
      identityBody('https://www.threads.com/@/post/Other'),
    ],
    [
      'redacted identity with case-changed shortcode',
      identityBody('https://www.threads.com/@/post/abcde'),
    ],
    [
      'redacted identity with percent-encoded shortcode',
      identityBody('https://www.threads.com/@/post/Abcd%65'),
    ],
    ['redacted identity with HTTP', identityBody(`${insecureHttp}//www.threads.com/@/post/Abcde`)],
    [
      'redacted identity with a similar host',
      identityBody('https://www.threads.com.attacker.example/@/post/Abcde'),
    ],
    [
      'redacted identity with an explicit port',
      identityBody('https://www.threads.com:443/@/post/Abcde'),
    ],
    ['redacted identity with a query', identityBody(`${USERNAME_REDACTED_URL}?view=media`)],
    ['redacted identity with a fragment', identityBody(`${USERNAME_REDACTED_URL}#media`)],
    ['redacted identity with a trailing slash', identityBody(`${USERNAME_REDACTED_URL}/`)],
    ['redacted identity with extra path', identityBody(`${USERNAME_REDACTED_URL}/extra`)],
    [
      'canonical and Open Graph identity disagreement',
      successBody(
        [],
        [],
        [element([{ name: 'href', value: USERNAME_REDACTED_URL }])],
        [element([{ name: 'content', value: CANONICAL_URL }])],
      ),
    ],
  ] as const)('rejects identity evidence with %s', async (_name, body) => {
    await expectResolverError(
      resolver(browserReturning(() => jsonResponse(body))).resolve(post),
      'RENDERED_RESPONSE_INVALID',
      ['Related', 'private=redirected', PRIVATE_URL],
    );
  });

  it.each([
    ['extra envelope field', { ...successBody(), provider: 'private-provider-detail' }],
    ['provider error shape', { success: false, errors: [{ message: 'private-provider-detail' }] }],
    [
      'wrong selector order',
      {
        success: true,
        result: [
          { selector: OPEN_GRAPH_SELECTOR, results: [] },
          { selector: CANONICAL_SELECTOR, results: [] },
          { selector: VIDEO_SELECTOR, results: [] },
          { selector: SOURCE_SELECTOR, results: [] },
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

  it('selects the first allowed video deterministically from multiple unique results', async () => {
    const results = [
      element([{ name: 'src', value: 'https://attacker.example/blocked.mp4' }]),
      ...Array.from({ length: 2 }, (_, index) =>
        element([
          {
            name: 'src',
            value: `https://video.cdninstagram.com/${String(index)}.mp4?token=private-${String(index)}`,
          },
        ]),
      ),
    ];
    const result = await resolver(
      browserReturning(() => jsonResponse(successBody(results))),
    ).resolve(post);

    expect(result.candidates.map(({ value }) => value.url.href)).toEqual([
      'https://video.cdninstagram.com/0.mp4?token=private-0',
    ]);
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

  it('maps provider and body-read failures without provider details', async () => {
    const providerSecret = 'private-provider-selector-timeout';
    await expectResolverError(
      resolver({
        async quickAction() {
          throw new Error(providerSecret);
        },
      }).resolve(post),
      'RENDERED_UNAVAILABLE',
      [providerSecret],
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

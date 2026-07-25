import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import {
  createPublicThreadsMarkupResolver,
  PublicThreadsMarkupResolverError,
  type PublicThreadsMarkupResolverErrorCode,
  type ThreadsMarkupFetch,
} from '../src/resolver/public-threads-markup.js';
import {
  parseThreadsPostUrl,
  type NormalizedThreadsPost,
  type ThreadsPostUrl,
} from '../src/security/upstream-policy.js';

const MAX_MARKUP_BYTES = 2 * 1024 * 1024;
const encoder = new TextEncoder();
const post = parseThreadsPostUrl('https://threads.com/@alice/post/Abcde?discard=input');

function fixtureUrl(name: string): string {
  return `https://video.cdninstagram.com/${name}.mp4?fixture=${name}`;
}

function mediaMarkup(name = 'primary'): string {
  return `<meta property="og:video" content="${fixtureUrl(name)}">`;
}

function sizedMarkup(size: number, name = 'boundary'): string {
  const prefix = mediaMarkup(name);
  if (prefix.length > size) {
    throw new RangeError('fixture size is too small');
  }
  return `${prefix}${' '.repeat(size - prefix.length)}`;
}

function htmlResponse(
  body: BodyInit | null,
  options: {
    readonly contentLength?: string;
    readonly contentType?: string | null;
    readonly status?: number;
  } = {},
): Response {
  const headers = new Headers();
  if (options.contentType !== null) {
    headers.set('content-type', options.contentType ?? 'text/html; charset=utf-8');
  }
  if (options.contentLength !== undefined) {
    headers.set('content-length', options.contentLength);
  }
  return new Response(body, { headers, status: options.status ?? 200 });
}

function resolver(
  fetcher: ThreadsMarkupFetch,
  controller = new AbortController(),
  timeoutCalls: number[] = [],
) {
  return createPublicThreadsMarkupResolver({
    fetch: fetcher,
    timeoutSignal(milliseconds) {
      timeoutCalls.push(milliseconds);
      return controller.signal;
    },
  });
}

async function expectResolverError(
  action: Promise<unknown>,
  code: PublicThreadsMarkupResolverErrorCode,
  secrets: readonly string[] = [],
): Promise<void> {
  let caught: unknown;
  try {
    await action;
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PublicThreadsMarkupResolverError);
  expect(caught).toMatchObject({ code, message: code });
  for (const secret of secrets) {
    expect((caught as Error).message).not.toContain(secret);
  }
}

function cancellableResponse(
  status: number,
  location?: string,
): {
  readonly cancelled: () => number;
  readonly response: Response;
} {
  let cancelCount = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('redirect body secret'));
    },
    cancel() {
      cancelCount += 1;
    },
  });
  const headers = new Headers();
  if (location !== undefined) {
    headers.set('location', location);
  }
  return {
    cancelled: () => cancelCount,
    response: new Response(body, { headers, status }),
  };
}

describe('PublicThreadsMarkupResolver', () => {
  it('constructs a credential-free fixed request and creates one total timeout', async () => {
    expectTypeOf<ThreadsPostUrl>().toEqualTypeOf<NormalizedThreadsPost>();
    const requests: Request[] = [];
    const timeoutCalls: number[] = [];
    const controller = new AbortController();
    const subject = resolver(
      async (request) => {
        requests.push(request);
        return htmlResponse(mediaMarkup());
      },
      controller,
      timeoutCalls,
    );

    const result = await subject.resolve(post);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.value.url.pathname).toBe('/primary.mp4');
    expect(timeoutCalls).toEqual([8_000]);
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.url).toBe('https://www.threads.com/@alice/post/Abcde');
    expect(request.method).toBe('GET');
    expect(request.redirect).toBe('manual');
    expect(request.credentials).toBe('omit');
    expect(request.referrer).toBe('');
    expect([...request.headers.entries()]).toEqual([
      ['accept', 'text/html, application/xhtml+xml;q=0.9'],
      ['accept-language', 'en-US,en;q=0.8'],
      ['user-agent', 'ThreadsDownloader/0.1'],
    ]);
    expect(request.headers.has('authorization')).toBe(false);
    expect(request.headers.has('cookie')).toBe(false);
    expect(request.headers.has('referer')).toBe(false);
    controller.abort();
    expect(request.signal.aborted).toBe(true);
  });

  it('resolves relative and alternate-host redirects through canonical post URLs', async () => {
    const first = cancellableResponse(302, '../post/Fghij?discard=first');
    const second = cancellableResponse(307, 'https://threads.net/@bob/post/Klmno/?discard=second');
    const responses = [first.response, second.response, htmlResponse(mediaMarkup('redirected'))];
    const requests: Request[] = [];
    const timeoutCalls: number[] = [];
    const subject = resolver(
      async (request) => {
        requests.push(request);
        return responses.shift()!;
      },
      new AbortController(),
      timeoutCalls,
    );

    await expect(subject.resolve(post)).resolves.toHaveProperty('candidates.length', 1);
    expect(requests.map((request) => request.url)).toEqual([
      'https://www.threads.com/@alice/post/Abcde',
      'https://www.threads.com/@alice/post/Fghij',
      'https://www.threads.com/@bob/post/Klmno',
    ]);
    expect(first.cancelled()).toBe(1);
    expect(second.cancelled()).toBe(1);
    expect(timeoutCalls).toEqual([8_000]);
  });

  it('follows three redirects and rejects the fourth without another fetch', async () => {
    const allowed = Array.from({ length: 3 }, (_, index) =>
      cancellableResponse(302, `/@alice/post/Next${String(index)}`),
    );
    const allowedResponses = [
      ...allowed.map(({ response }) => response),
      htmlResponse(mediaMarkup('after-three')),
    ];
    let allowedFetches = 0;
    const allowedSubject = resolver(async () => {
      allowedFetches += 1;
      return allowedResponses.shift()!;
    });
    await expect(allowedSubject.resolve(post)).resolves.toHaveProperty('candidates.length', 1);
    expect(allowedFetches).toBe(4);
    expect(allowed.map(({ cancelled }) => cancelled())).toEqual([1, 1, 1]);

    const denied = Array.from({ length: 4 }, (_, index) =>
      cancellableResponse(302, `/@alice/post/Again${String(index)}`),
    );
    let deniedFetches = 0;
    const deniedSubject = resolver(async () => {
      deniedFetches += 1;
      return denied[deniedFetches - 1]!.response;
    });
    await expectResolverError(deniedSubject.resolve(post), 'THREADS_REDIRECT_LIMIT');
    expect(deniedFetches).toBe(4);
    expect(denied.map(({ cancelled }) => cancelled())).toEqual([1, 1, 1, 1]);
  });

  it('rejects every malformed redirect target and cancels its body', async () => {
    const invalidLocations = [
      undefined,
      'https://attacker.example/@alice/post/Abcde?secret=host',
      'https://threads.com/not-a-post?secret=path',
      // eslint-disable-next-line sonarjs/no-clear-text-protocols -- verifies HTTPS-only redirect validation.
      'http://threads.com/@alice/post/Abcde?secret=scheme',
    ];
    for (const location of invalidLocations) {
      const redirect = cancellableResponse(302, location);
      let fetches = 0;
      const subject = resolver(async () => {
        fetches += 1;
        return redirect.response;
      });
      await expectResolverError(subject.resolve(post), 'THREADS_REDIRECT_INVALID', [
        location ?? 'redirect body secret',
      ]);
      expect(fetches).toBe(1);
      expect(redirect.cancelled()).toBe(1);
    }
  });

  it('maps final denial statuses without reading or leaking their bodies', async () => {
    const cases = [
      [401, 'THREADS_LOGIN_REQUIRED'],
      [403, 'THREADS_ACCESS_DENIED'],
      [429, 'THREADS_RATE_LIMITED'],
      [503, 'THREADS_UPSTREAM_UNAVAILABLE'],
    ] as const;
    for (const [status, code] of cases) {
      const response = cancellableResponse(status);
      let fetches = 0;
      const subject = resolver(async () => {
        fetches += 1;
        return response.response;
      });
      await expectResolverError(subject.resolve(post), code, [
        'redirect body secret',
        String(status),
      ]);
      expect(fetches).toBe(1);
      expect(response.cancelled()).toBe(1);
    }
  });

  it('does not retry network, abort, timeout-factory, or body-read failures', async () => {
    let networkFetches = 0;
    const networkSecret = 'private-network-detail';
    const networkSubject = resolver(async () => {
      networkFetches += 1;
      throw new Error(networkSecret);
    });
    await expectResolverError(networkSubject.resolve(post), 'THREADS_UPSTREAM_UNAVAILABLE', [
      networkSecret,
    ]);
    expect(networkFetches).toBe(1);

    const aborted = new AbortController();
    aborted.abort();
    let abortFetches = 0;
    const abortSubject = resolver(async (request) => {
      abortFetches += 1;
      expect(request.signal.aborted).toBe(true);
      throw new DOMException('private abort reason', 'AbortError');
    }, aborted);
    await expectResolverError(abortSubject.resolve(post), 'THREADS_UPSTREAM_UNAVAILABLE');
    expect(abortFetches).toBe(1);

    let timeoutFetches = 0;
    const timeoutSubject = createPublicThreadsMarkupResolver({
      fetch: async () => {
        timeoutFetches += 1;
        return htmlResponse(mediaMarkup());
      },
      timeoutSignal() {
        throw new Error('private timer failure');
      },
    });
    await expectResolverError(timeoutSubject.resolve(post), 'THREADS_UPSTREAM_UNAVAILABLE', [
      'private timer failure',
    ]);
    expect(timeoutFetches).toBe(0);

    let readFetches = 0;
    const failingBody = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error('private body read failure');
      },
    });
    const readSubject = resolver(async () => {
      readFetches += 1;
      return htmlResponse(failingBody);
    });
    await expectResolverError(readSubject.resolve(post), 'THREADS_UPSTREAM_UNAVAILABLE', [
      'private body read failure',
    ]);
    expect(readFetches).toBe(1);
  });

  it('accepts only HTML media types with case-insensitive type and optional parameters', async () => {
    for (const contentType of [
      ' Text/HTML ; charset = UTF-8 ',
      'APPLICATION/XHTML+XML;charset=utf-8',
    ]) {
      const subject = resolver(async () => htmlResponse(mediaMarkup(), { contentType }));
      await expect(subject.resolve(post)).resolves.toHaveProperty('candidates.length', 1);
    }

    for (const contentType of [
      null,
      'text/plain',
      'text/htmlx',
      'text/html, application/xhtml+xml',
    ]) {
      const body = contentType === null ? encoder.encode(mediaMarkup()) : mediaMarkup();
      const subject = resolver(async () => htmlResponse(body, { contentType }));
      await expectResolverError(subject.resolve(post), 'THREADS_RESPONSE_INVALID');
    }
  });

  it('requires canonical safe Content-Length and prechecks the declared size', async () => {
    for (const contentLength of ['00', '01', '+1', '-1', '1.0', '1, 1', '9007199254740992']) {
      const subject = resolver(async () => htmlResponse(mediaMarkup(), { contentLength }));
      await expectResolverError(subject.resolve(post), 'THREADS_RESPONSE_INVALID');
    }

    let pulls = 0;
    let cancellations = 0;
    const unreadBody = new ReadableStream<Uint8Array>(
      {
        pull() {
          pulls += 1;
        },
        cancel() {
          cancellations += 1;
        },
      },
      { highWaterMark: 0 },
    );
    const oversized = resolver(async () =>
      htmlResponse(unreadBody, { contentLength: String(MAX_MARKUP_BYTES + 1) }),
    );
    await expectResolverError(oversized.resolve(post), 'THREADS_RESPONSE_TOO_LARGE');
    expect(pulls).toBe(0);
    expect(cancellations).toBe(1);

    const exactMarkup = sizedMarkup(MAX_MARKUP_BYTES, 'declared-exact');
    const exact = resolver(async () =>
      htmlResponse(exactMarkup, { contentLength: String(MAX_MARKUP_BYTES) }),
    );
    await expect(exact.resolve(post)).resolves.toHaveProperty('candidates.length', 1);
  });

  it('accepts an unknown-length 2 MiB stream and cancels one byte beyond it', async () => {
    const exactMarkup = sizedMarkup(MAX_MARKUP_BYTES, 'actual-exact');
    const exact = resolver(async () => htmlResponse(exactMarkup));
    await expect(exact.resolve(post)).resolves.toHaveProperty('candidates.length', 1);

    let cancellations = 0;
    const oversizedBytes = encoder.encode(sizedMarkup(MAX_MARKUP_BYTES + 1, 'actual-over'));
    const oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(oversizedBytes);
      },
      cancel() {
        cancellations += 1;
      },
    });
    const oversized = resolver(async () => htmlResponse(oversizedBody));
    await expectResolverError(oversized.resolve(post), 'THREADS_RESPONSE_TOO_LARGE');
    expect(cancellations).toBe(1);
  });

  it('uses only the response reader and rejects missing bodies or invalid UTF-8', async () => {
    const response = htmlResponse(mediaMarkup());
    const text = vi.spyOn(response, 'text');
    const arrayBuffer = vi.spyOn(response, 'arrayBuffer');
    const subject = resolver(async () => response);
    await expect(subject.resolve(post)).resolves.toHaveProperty('candidates.length', 1);
    expect(text).not.toHaveBeenCalled();
    expect(arrayBuffer).not.toHaveBeenCalled();

    const missing = resolver(async () => htmlResponse(null));
    await expectResolverError(missing.resolve(post), 'THREADS_RESPONSE_INVALID');

    const invalidUtf8 = resolver(async () => htmlResponse(Uint8Array.of(0xff)));
    await expectResolverError(invalidUtf8.resolve(post), 'THREADS_RESPONSE_INVALID');
  });

  it('classifies clear empty pages and otherwise reports no media', async () => {
    const cases = [
      [
        '<form action="/login"><input type="password"><button>Log in</button></form>',
        'THREADS_LOGIN_REQUIRED',
      ],
      ['<h1>Temporarily blocked</h1><p>Automated behavior detected.</p>', 'THREADS_BOT_BLOCKED'],
      [
        '<noscript>This page requires JavaScript. Please enable JavaScript.</noscript>',
        'THREADS_JAVASCRIPT_REQUIRED',
      ],
      ['<main>Public post without downloadable media.</main>', 'THREADS_MEDIA_NOT_FOUND'],
    ] as const;
    for (const [markup, code] of cases) {
      const subject = resolver(async () => htmlResponse(markup));
      await expectResolverError(subject.resolve(post), code, [markup]);
    }
  });

  it('returns a valid candidate before considering wall markers', async () => {
    const markup = [
      '<form><input type="password"><span>Log in</span></form>',
      '<p>Temporarily blocked automated behavior.</p>',
      '<noscript>Please enable JavaScript.</noscript>',
      mediaMarkup('preferred'),
    ].join('');
    const subject = resolver(async () => htmlResponse(markup));

    const result = await subject.resolve(post);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.value.url.pathname).toBe('/preferred.mp4');
  });

  it('maps malformed markup to a safe response error', async () => {
    const secret = 'private-structure-detail';
    const subject = resolver(async () =>
      htmlResponse(`<script type="application/json">{"url":"${secret}"}`),
    );
    await expectResolverError(subject.resolve(post), 'THREADS_RESPONSE_INVALID', [secret]);
  });
});

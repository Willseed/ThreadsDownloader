import { describe, expect, it, vi } from 'vitest';

import {
  createResolvePublicMediaHandler,
  serializeResolveFailureEvent,
  type ResolveFailureEvent,
  type ResolvePublicMediaBindings,
  type ResolvePublicMediaRuntime,
} from '../src/workflows/resolve-public-media.js';
import { SESSION_COOKIE_NAME } from '../src/security/browser-session.js';
import { createOpaqueValueSigner, importSigningKey } from '../src/security/cryptography.js';
import type { IpRateLimitNamespace } from '../src/security/resolve-limits.js';
import type { SessionNamespace } from '../src/security/session-client.js';
import type { TurnstileReplayNamespace } from '../src/security/turnstile.js';
import type {
  BrowserRunScrapePort,
  RenderedBrowserScrapeOptions,
} from '../src/resolver/rendered-threads-media.js';
import { encodeBase64Url } from '../src/utils/base64url.js';

const NOW = Date.parse('2026-07-25T00:00:00.000Z');
const EXPECTED_HOST = 'threads.example';
const EXPECTED_ORIGIN = `https://${EXPECTED_HOST}`;
const SIGNING_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const RAW_SESSION_ID = encodeBase64Url(new Uint8Array(32).fill(1));
const CSRF_TOKEN = encodeBase64Url(new Uint8Array(32).fill(2));
const TURNSTILE_TOKEN = 'private-turnstile-token';
const POST_URL = 'https://threads.com/@alice/post/Abcde?private=query-token';
const PRIVATE_CDN_QUERY = 'private-cdn-query';
const REQUEST_ID = 'A'.repeat(32);
const RESOLVE_ID = encodeBase64Url(new Uint8Array(24).fill(3));
const RENDERED_PRIVATE_URL =
  'https://instagram.ftpe7-2.fna.fbcdn.net/media/rendered.mp4?token=private-rendered-token';
const PRIVATE_FNA_URLS = [
  'https://instagram.ftpe7-2.fna.fbcdn.net/media/first.mp4?token=private-fna-first',
  'https://instagram.ftpe7-2.fna.fbcdn.net/media/second.mp4?token=private-fna-second',
] as const;

interface HarnessOptions {
  readonly clockError?: string;
  readonly ipAcquireStatus?: number;
  readonly markupContentType?: string;
  readonly markupResponse?: () => Response | Promise<Response>;
  readonly markupUrls?: readonly string[];
  readonly probeResponse?: (request: Request, index: number) => Response | Promise<Response>;
  readonly rendererEnabled?: boolean;
  readonly rendererResponse?: (
    options: RenderedBrowserScrapeOptions,
  ) => Response | Promise<Response>;
  readonly replayStatus?: number;
  readonly reporterThrows?: boolean;
  readonly sessionAcquireStatus?: number;
  readonly siteverifyResponse?: () => Response | Promise<Response>;
  readonly vaultResponse?: (body: Record<string, unknown>) => Response | Promise<Response>;
  readonly clock?: (call: number) => number;
}

interface HarnessControls {
  readonly clockValues: number[];
  readonly failureEvents: ResolveFailureEvent[];
  readonly ipBodies: Record<string, unknown>[];
  readonly rendererCalls: Array<{
    readonly action: string;
    readonly options: RenderedBrowserScrapeOptions;
  }>;
  readonly probeRequests: Request[];
  readonly sequence: string[];
  readonly sessionBodies: Record<string, unknown>[];
  readonly siteverifyRequests: Request[];
  readonly vaultBodies: Record<string, unknown>[];
}

interface Harness {
  readonly bindings: ResolvePublicMediaBindings;
  readonly controls: HarnessControls;
  readonly runtime: ResolvePublicMediaRuntime;
}

function candidateId(index: number): string {
  return encodeBase64Url(new Uint8Array(24).fill(index + 4));
}

function defaultUrls(count = 3): readonly string[] {
  return Array.from(
    { length: count },
    (_, index) =>
      `https://video.cdninstagram.com/media-${String(index)}.mp4?token=${PRIVATE_CDN_QUERY}-${String(index)}`,
  );
}

function mediaMarkup(urls: readonly string[]): string {
  return urls.map((url) => `<meta property="og:video" content="${url}">`).join('');
}

function videoResponse(contentLength = 42): Response {
  return new Response(null, {
    status: 200,
    headers: {
      'accept-ranges': 'bytes',
      'content-length': String(contentLength),
      'content-type': 'video/mp4',
      etag: '"strong-v1"',
    },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function renderedElement(attributes: readonly { readonly name: string; readonly value: string }[]) {
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

function renderedIdentity(options: RenderedBrowserScrapeOptions): readonly unknown[] {
  const canonicalUrl = options.url.slice(0, -'/media'.length);
  return [
    {
      selector: options.elements[0]!.selector,
      results: [renderedElement([{ name: 'href', value: canonicalUrl }])],
    },
    {
      selector: options.elements[1]!.selector,
      results: [renderedElement([{ name: 'content', value: canonicalUrl }])],
    },
  ];
}

function renderedResponse(
  options: RenderedBrowserScrapeOptions,
  url = RENDERED_PRIVATE_URL,
): Response {
  return jsonResponse({
    success: true,
    result: [
      ...renderedIdentity(options),
      {
        selector: options.elements[2]!.selector,
        results: [renderedElement([{ name: 'src', value: url }])],
      },
      { selector: options.elements[3]!.selector, results: [] },
    ],
  });
}

function emptyRenderedResponse(options: RenderedBrowserScrapeOptions): Response {
  return jsonResponse({
    success: true,
    result: [
      ...renderedIdentity(options),
      { selector: options.elements[2]!.selector, results: [] },
      { selector: options.elements[3]!.selector, results: [] },
    ],
  });
}

function browserBinding(options: HarnessOptions, controls: HarnessControls): BrowserRunScrapePort {
  return {
    async quickAction(action, scrapeOptions) {
      controls.sequence.push('browser:scrape');
      controls.rendererCalls.push({ action, options: scrapeOptions });
      return options.rendererResponse?.(scrapeOptions) ?? renderedResponse(scrapeOptions);
    },
  };
}

function sessionNamespace(options: HarnessOptions, controls: HarnessControls): SessionNamespace {
  return {
    idFromName(name) {
      expect(name).toBe(RAW_SESSION_ID);
      return {} as DurableObjectId;
    },
    get() {
      return {
        async fetch(request) {
          const path = new URL(request.url).pathname;
          const body = (await request.json()) as Record<string, unknown>;
          controls.sessionBodies.push(body);
          if (path === '/resolve-permits/acquire') {
            controls.sequence.push('session:acquire');
            const status = options.sessionAcquireStatus ?? 201;
            return jsonResponse(
              status === 201
                ? { ok: true, expiresAt: (body['now'] as number) + 60_000 }
                : { ok: false },
              status,
            );
          }
          if (path === '/resolve-permits/release') {
            controls.sequence.push('session:release');
            return jsonResponse({ ok: true });
          }
          if (path === '/resolve-vault/store') {
            controls.sequence.push('vault:store');
            controls.vaultBodies.push(body);
            if (options.vaultResponse !== undefined) {
              return options.vaultResponse(body);
            }
            const candidates = body['candidates'] as readonly Record<string, unknown>[];
            return jsonResponse(
              {
                ok: true,
                resolveId: RESOLVE_ID,
                issuedAt: (body['now'] as number) + 50,
                expiresAt: (body['now'] as number) + 50 + 300_000,
                candidates: candidates.map((candidate, index) => ({
                  candidateId: candidateId(index),
                  filename: `threads_Abcde_${String(index + 1)}.mp4`,
                  ...(candidate['contentLength'] === null
                    ? {}
                    : { contentLength: candidate['contentLength'] }),
                })),
              },
              201,
            );
          }
          throw new Error(`unexpected private session path: ${path}`);
        },
      };
    },
  };
}

function ipNamespace(options: HarnessOptions, controls: HarnessControls): IpRateLimitNamespace {
  return {
    idFromName() {
      return {} as DurableObjectId;
    },
    get() {
      return {
        async fetch(request) {
          const path = new URL(request.url).pathname;
          const body = (await request.json()) as Record<string, unknown>;
          controls.ipBodies.push(body);
          if (path === '/acquire') {
            controls.sequence.push('ip:acquire');
            const status = options.ipAcquireStatus ?? 201;
            return jsonResponse(
              status === 201
                ? { ok: true, expiresAt: (body['now'] as number) + 60_000 }
                : { ok: false },
              status,
            );
          }
          if (path === '/release') {
            controls.sequence.push('ip:release');
            return jsonResponse({ ok: true });
          }
          throw new Error(`unexpected private IP path: ${path}`);
        },
      };
    },
  };
}

function replayNamespace(
  options: HarnessOptions,
  controls: HarnessControls,
): TurnstileReplayNamespace {
  return {
    idFromName() {
      return {} as DurableObjectId;
    },
    get() {
      return {
        async fetch() {
          controls.sequence.push('turnstile:reserve');
          const status = options.replayStatus ?? 201;
          return jsonResponse({ ok: status === 201 }, status);
        },
      };
    },
  };
}

function runtimeFetcher(options: HarnessOptions, controls: HarnessControls): typeof fetch {
  const urls = options.markupUrls ?? defaultUrls();
  let probeIndex = 0;
  return vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === 'challenges.cloudflare.com') {
      controls.sequence.push('turnstile:siteverify');
      controls.siteverifyRequests.push(request);
      if (options.siteverifyResponse !== undefined) {
        return options.siteverifyResponse();
      }
      return jsonResponse({
        success: true,
        hostname: EXPECTED_HOST,
        action: 'resolve',
        challenge_ts: new Date(NOW).toISOString(),
      });
    }
    if (url.hostname === 'www.threads.com') {
      controls.sequence.push('threads:markup');
      if (options.markupResponse !== undefined) {
        return options.markupResponse();
      }
      return new Response(mediaMarkup(urls), {
        status: 200,
        headers: { 'content-type': options.markupContentType ?? 'text/html; charset=utf-8' },
      });
    }
    if (url.hostname.endsWith('.cdninstagram.com') || url.hostname.endsWith('.fna.fbcdn.net')) {
      const index = probeIndex;
      probeIndex += 1;
      controls.sequence.push(`probe:${String(index)}`);
      controls.probeRequests.push(request);
      return options.probeResponse?.(request, index) ?? videoResponse(42 + index);
    }
    throw new Error(`unexpected private fetch target: ${url.href}`);
  });
}

function createHarness(options: HarnessOptions = {}): Harness {
  const controls: HarnessControls = {
    clockValues: [],
    failureEvents: [],
    ipBodies: [],
    rendererCalls: [],
    probeRequests: [],
    sequence: [],
    sessionBodies: [],
    siteverifyRequests: [],
    vaultBodies: [],
  };
  let clockOffset = 0;
  const runtime: ResolvePublicMediaRuntime = {
    fetcher: runtimeFetcher(options, controls),
    now() {
      if (options.clockError !== undefined) {
        throw new Error(options.clockError);
      }
      const value = options.clock?.(clockOffset / 100) ?? NOW + clockOffset;
      clockOffset += 100;
      controls.clockValues.push(value);
      return value;
    },
    reportFailure(event) {
      controls.failureEvents.push(event);
      if (options.reporterThrows === true) {
        throw new Error('private reporter failure');
      }
    },
    requestId: () => REQUEST_ID,
  };
  const bindings: ResolvePublicMediaBindings = {
    ...(options.rendererEnabled === true || options.rendererResponse !== undefined
      ? { BROWSER: browserBinding(options, controls) }
      : {}),
    EXPECTED_HOST,
    EXPECTED_ORIGIN,
    IP_RATE_LIMITS: ipNamespace(options, controls),
    SESSION_SIGNING_KEY: SIGNING_KEY,
    SESSIONS: sessionNamespace(options, controls),
    TURNSTILE_REPLAYS: replayNamespace(options, controls),
    TURNSTILE_SECRET: 'private-turnstile-secret',
  };
  return { bindings, controls, runtime };
}

async function signedCookie(): Promise<string> {
  const signer = createOpaqueValueSigner(await importSigningKey(SIGNING_KEY));
  return `${SESSION_COOKIE_NAME}=${await signer.sign(RAW_SESSION_ID)}`;
}

interface RequestOptions {
  readonly body?: unknown;
  readonly contentLength?: number | null;
  readonly cookie?: string | null;
  readonly ip?: string | null;
  readonly origin?: string | null;
  readonly rawBody?: string;
  readonly contentType?: string | null;
}

async function resolveRequest(options: RequestOptions = {}): Promise<Request> {
  const body =
    options.rawBody ??
    JSON.stringify(
      options.body ?? {
        postUrl: POST_URL,
        csrfToken: CSRF_TOKEN,
        turnstileToken: TURNSTILE_TOKEN,
        rightsConfirmed: true,
      },
    );
  const headers = new Headers();
  if (options.origin !== null) {
    headers.set('origin', options.origin ?? EXPECTED_ORIGIN);
  }
  if (options.contentType !== null) {
    headers.set('content-type', options.contentType ?? 'application/json');
  }
  if (options.cookie !== null) {
    headers.set('cookie', options.cookie ?? (await signedCookie()));
  }
  if (options.ip !== null) {
    headers.set('CF-Connecting-IP', options.ip ?? '203.0.113.42');
  }
  if (options.contentLength !== undefined && options.contentLength !== null) {
    headers.set('content-length', String(options.contentLength));
  }
  return new Request(`${EXPECTED_ORIGIN}/api/resolve`, {
    method: 'POST',
    headers,
    body,
  });
}

async function execute(
  harness: Harness,
  options: RequestOptions = {},
): Promise<{ readonly body: string; readonly response: Response }> {
  const response = await createResolvePublicMediaHandler(harness.runtime)(
    await resolveRequest(options),
    harness.bindings,
  );
  return { response, body: await response.text() };
}

function expectError(body: string, code: string): void {
  expect(JSON.parse(body)).toEqual({
    error: {
      code,
      message: expect.any(String),
      requestId: REQUEST_ID,
    },
  });
}

function expectPublicBodySafe(body: string, extraSecrets: readonly string[] = []): void {
  for (const secret of [
    POST_URL,
    'query-token',
    CSRF_TOKEN,
    TURNSTILE_TOKEN,
    RAW_SESSION_ID,
    PRIVATE_CDN_QUERY,
    'private-turnstile-secret',
    'stack',
    ...extraSecrets,
  ]) {
    expect(body).not.toContain(secret);
  }
}

function expectFailureEventsSafe(
  events: readonly ResolveFailureEvent[],
  extraSecrets: readonly string[] = [],
): void {
  const serialized = JSON.stringify(events);
  for (const secret of [
    POST_URL,
    'query-token',
    CSRF_TOKEN,
    TURNSTILE_TOKEN,
    RAW_SESSION_ID,
    PRIVATE_CDN_QUERY,
    RENDERED_PRIVATE_URL,
    'private-turnstile-secret',
    'stack',
    ...extraSecrets,
  ]) {
    expect(serialized).not.toContain(secret);
  }
}

function releaseCounts(controls: HarnessControls): {
  readonly ip: number;
  readonly session: number;
} {
  return {
    ip: controls.sequence.filter((entry) => entry === 'ip:release').length,
    session: controls.sequence.filter((entry) => entry === 'session:release').length,
  };
}

describe('resolve public media request policy', () => {
  it.each([
    [{ origin: null }, 400, 'REQUEST_INVALID'],
    [{ origin: 'https://attacker.example' }, 400, 'REQUEST_INVALID'],
    [{ contentType: 'text/plain' }, 400, 'REQUEST_INVALID'],
    [{ rawBody: '{broken' }, 400, 'REQUEST_INVALID'],
    [{ body: [] }, 400, 'REQUEST_INVALID'],
    [
      {
        body: {
          postUrl: POST_URL,
          csrfToken: CSRF_TOKEN,
          turnstileToken: TURNSTILE_TOKEN,
          rightsConfirmed: true,
          extra: 'private-extra',
        },
      },
      400,
      'REQUEST_INVALID',
    ],
    [
      {
        body: {
          postUrl: POST_URL,
          csrfToken: CSRF_TOKEN,
          turnstileToken: TURNSTILE_TOKEN,
          rightsConfirmed: false,
        },
      },
      400,
      'REQUEST_INVALID',
    ],
    [
      {
        body: {
          postUrl: POST_URL,
          csrfToken: 'not-canonical-csrf',
          turnstileToken: TURNSTILE_TOKEN,
          rightsConfirmed: true,
        },
      },
      400,
      'REQUEST_INVALID',
    ],
  ] as const)(
    'rejects malformed input before any durable or upstream side effect',
    async (input, status, code) => {
      const harness = createHarness({ rendererEnabled: true });
      const result = await execute(harness, input);

      expect(result.response.status).toBe(status);
      expect(result.response.headers.get('cache-control')).toBe('no-store');
      expectError(result.body, code);
      expectPublicBodySafe(result.body);
      expect(harness.controls.sequence).toEqual([]);
      expect(harness.controls.rendererCalls).toEqual([]);
      expect(harness.controls.failureEvents).toEqual([]);
    },
  );

  it('enforces declared/actual byte equality and the 16 KiB limit', async () => {
    const regularBody = JSON.stringify({
      postUrl: POST_URL,
      csrfToken: CSRF_TOKEN,
      turnstileToken: TURNSTILE_TOKEN,
      rightsConfirmed: true,
    });
    const mismatch = createHarness();
    const mismatchResult = await execute(mismatch, {
      rawBody: regularBody,
      contentLength: new TextEncoder().encode(regularBody).byteLength + 1,
    });
    expect(mismatchResult.response.status).toBe(400);
    expectError(mismatchResult.body, 'REQUEST_INVALID');
    expect(mismatch.controls.sequence).toEqual([]);

    const tooLarge = createHarness();
    const tooLargeResult = await execute(tooLarge, { rawBody: 'x'.repeat(16_385) });
    expect(tooLargeResult.response.status).toBe(413);
    expectError(tooLargeResult.body, 'REQUEST_TOO_LARGE');
    expect(tooLarge.controls.sequence).toEqual([]);

    const declaredTooLarge = createHarness();
    const declaredResult = await execute(declaredTooLarge, {
      rawBody: '{}',
      contentLength: 16_385,
    });
    expect(declaredResult.response.status).toBe(413);
    expectError(declaredResult.body, 'REQUEST_TOO_LARGE');
    expect(declaredTooLarge.controls.sequence).toEqual([]);
  });

  it('rejects bad cookies and URLs before acquiring capacity', async () => {
    const badCookie = createHarness({ rendererEnabled: true });
    const cookieResult = await execute(badCookie, {
      cookie: `${SESSION_COOKIE_NAME}=tampered.private-cookie`,
    });
    expect(cookieResult.response.status).toBe(401);
    expectError(cookieResult.body, 'SESSION_INVALID');
    expect(badCookie.controls.sequence).toEqual([]);
    expect(badCookie.controls.rendererCalls).toEqual([]);

    const badUrl = createHarness({ rendererEnabled: true });
    const urlResult = await execute(badUrl, {
      body: {
        postUrl: 'https://attacker.example/private-query',
        csrfToken: CSRF_TOKEN,
        turnstileToken: TURNSTILE_TOKEN,
        rightsConfirmed: true,
      },
    });
    expect(urlResult.response.status).toBe(400);
    expectError(urlResult.body, 'URL_INVALID');
    expectPublicBodySafe(urlResult.body, ['attacker.example', 'private-cookie']);
    expect(badUrl.controls.sequence).toEqual([]);
    expect(badUrl.controls.rendererCalls).toEqual([]);
  });
});

describe('resolve public media workflow', () => {
  it('executes the full workflow in order and exposes only the safe vault view', async () => {
    const harness = createHarness();
    const { response, body } = await execute(harness);
    const decoded = JSON.parse(body) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.has('access-control-allow-origin')).toBe(false);
    expect(decoded).toEqual({
      resolveId: RESOLVE_ID,
      expiresAt: new Date(NOW + 350 + 300_000).toISOString(),
      candidates: [
        { candidateId: candidateId(0), filename: 'threads_Abcde_1.mp4', contentLength: 42 },
        { candidateId: candidateId(1), filename: 'threads_Abcde_2.mp4', contentLength: 43 },
        { candidateId: candidateId(2), filename: 'threads_Abcde_3.mp4', contentLength: 44 },
      ],
    });
    expect(harness.controls.failureEvents).toEqual([]);
    expect(harness.controls.sequence).toEqual([
      'session:acquire',
      'ip:acquire',
      'turnstile:reserve',
      'turnstile:siteverify',
      'threads:markup',
      'probe:0',
      'probe:1',
      'probe:2',
      'vault:store',
      'session:release',
      'ip:release',
    ]);
    expect(releaseCounts(harness.controls)).toEqual({ session: 1, ip: 1 });
    expect(harness.controls.siteverifyRequests).toHaveLength(1);
    const turnstileForm = await harness.controls.siteverifyRequests[0]!.formData();
    expect(turnstileForm.get('remoteip')).toBe('203.0.113.42');
    expect(turnstileForm.get('idempotency_key')).toBe(REQUEST_ID);
    expect(turnstileForm.get('response')).toBe(TURNSTILE_TOKEN);
    expect(harness.controls.vaultBodies[0]!['now']).toBe(NOW + 300);
    expect(harness.controls.clockValues).toEqual([NOW, NOW + 100, NOW + 200, NOW + 300, NOW + 400]);
    const permitId = harness.controls.sessionBodies[0]!['permitId'] as string;
    expectPublicBodySafe(body, [permitId, await signedCookie()]);
    expect(body).not.toContain('width');
    expect(body).not.toContain('height');
    expect(body).not.toContain('duration');
  });

  it('probes at most eight candidates concurrently and preserves source order', async () => {
    const urls = defaultUrls(12);
    const pending: Array<{ readonly index: number; readonly resolve: (value: Response) => void }> =
      [];
    let active = 0;
    let maximumActive = 0;
    const harness = createHarness({
      markupUrls: urls,
      probeResponse: async (_request, index) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        const response = await new Promise<Response>((resolve) => {
          pending.push({ index, resolve });
          if (pending.length === 8) {
            for (const item of [...pending].reverse()) {
              item.resolve(videoResponse(100 + item.index));
            }
          }
        });
        active -= 1;
        return response;
      },
    });

    const result = await execute(harness);

    expect(result.response.status).toBe(200);
    expect(harness.controls.probeRequests).toHaveLength(8);
    expect(maximumActive).toBe(8);
    const stored = harness.controls.vaultBodies[0]!['candidates'] as readonly Record<
      string,
      unknown
    >[];
    expect(stored.map((candidate) => candidate['finalUrl'])).toEqual(urls.slice(0, 8));
    expect(stored.map((candidate) => candidate['contentLength'])).toEqual(
      Array.from({ length: 8 }, (_, index) => 100 + index),
    );
    expect(releaseCounts(harness.controls)).toEqual({ session: 1, ip: 1 });
  });

  it('deduplicates redirect-converged final URLs while keeping the first source candidate', async () => {
    const shared = 'https://shared.cdninstagram.com/final.mp4?token=shared-private';
    const harness = createHarness({
      markupUrls: defaultUrls(2),
      probeResponse: (request) =>
        new URL(request.url).hostname === 'shared.cdninstagram.com'
          ? videoResponse(91)
          : new Response(null, { status: 302, headers: { location: shared } }),
    });

    const result = await execute(harness);

    expect(result.response.status).toBe(200);
    const stored = harness.controls.vaultBodies[0]!['candidates'] as readonly Record<
      string,
      unknown
    >[];
    expect(stored).toHaveLength(1);
    expect(stored[0]!['finalUrl']).toBe(shared);
    expectPublicBodySafe(result.body, ['shared-private']);
  });

  it('keeps successful probes in source order while skipping typed candidate failures', async () => {
    const harness = createHarness({
      probeResponse: async (request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === '/media-1.mp4') {
          return new Response(null, { status: 404 });
        }
        if (pathname === '/media-2.mp4') {
          throw new Error('private transient probe failure');
        }
        return videoResponse(77);
      },
    });

    const result = await execute(harness);

    expect(result.response.status).toBe(200);
    const stored = harness.controls.vaultBodies[0]!['candidates'] as readonly Record<
      string,
      unknown
    >[];
    expect(stored).toHaveLength(1);
    expect(stored[0]!['finalUrl']).toBe(defaultUrls()[0]);
    expect(releaseCounts(harness.controls)).toEqual({ session: 1, ip: 1 });
    expectPublicBodySafe(result.body, ['private transient probe failure']);
  });

  it.each([
    [
      'JavaScript shell',
      () =>
        new Response('<noscript>Enable JavaScript because JavaScript is required.</noscript>', {
          headers: { 'content-type': 'text/html' },
        }),
    ],
    [
      'missing media',
      () =>
        new Response('<main>Public post without downloadable media.</main>', {
          headers: { 'content-type': 'text/html' },
        }),
    ],
    [
      'invalid response',
      () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
    ],
    [
      'oversized response',
      () =>
        new Response('', {
          headers: { 'content-length': String(2 * 1024 * 1024 + 1), 'content-type': 'text/html' },
        }),
    ],
    ['upstream failure response', () => new Response(null, { status: 503 })],
    ['upstream transport rejection', () => Promise.reject(new Error('private markup transport'))],
  ] as const)(
    'falls back to rendered /media only for an allowed %s error',
    async (_name, markupResponse) => {
      const harness = createHarness({ rendererEnabled: true, markupResponse });

      const result = await execute(harness);

      expect(result.response.status).toBe(200);
      expect(harness.controls.sequence).toEqual([
        'session:acquire',
        'ip:acquire',
        'turnstile:reserve',
        'turnstile:siteverify',
        'threads:markup',
        'browser:scrape',
        'probe:0',
        'vault:store',
        'session:release',
        'ip:release',
      ]);
      expect(harness.controls.rendererCalls).toHaveLength(1);
      expect(harness.controls.rendererCalls[0]!.options.url).toBe(
        'https://www.threads.com/@alice/post/Abcde/media',
      );
      expect(harness.controls.probeRequests[0]!.url).toBe(RENDERED_PRIVATE_URL);
      expect(harness.controls.vaultBodies[0]!['candidates']).toEqual([
        expect.objectContaining({ finalUrl: RENDERED_PRIVATE_URL }),
      ]);
      expectPublicBodySafe(result.body, ['private-rendered-token', RENDERED_PRIVATE_URL]);
    },
  );

  it('fails closed before probing when rendering returns two distinct valid videos', async () => {
    const secondUrl = 'https://video.cdninstagram.com/related.mp4?token=private-related-token';
    const harness = createHarness({
      markupResponse: () =>
        new Response('<noscript>Enable JavaScript because JavaScript is required.</noscript>', {
          headers: { 'content-type': 'text/html' },
        }),
      rendererResponse: (options) =>
        jsonResponse({
          success: true,
          result: [
            ...renderedIdentity(options),
            {
              selector: options.elements[2]!.selector,
              results: [
                renderedElement([{ name: 'src', value: RENDERED_PRIVATE_URL }]),
                renderedElement([{ name: 'src', value: secondUrl }]),
              ],
            },
            { selector: options.elements[3]!.selector, results: [] },
          ],
        }),
    });

    const result = await execute(harness);

    expect(result.response.status).toBe(503);
    expectError(result.body, 'RESOLVE_UNAVAILABLE');
    expect(harness.controls.rendererCalls).toHaveLength(1);
    expect(harness.controls.probeRequests).toEqual([]);
    expect(harness.controls.vaultBodies).toEqual([]);
    expectPublicBodySafe(result.body, [RENDERED_PRIVATE_URL, secondUrl, 'private-related-token']);
  });

  it('retries one empty rendered result with the same canonical post inside the lease', async () => {
    let renderCall = 0;
    const harness = createHarness({
      markupResponse: () =>
        new Response('<noscript>Enable JavaScript because JavaScript is required.</noscript>', {
          headers: { 'content-type': 'text/html' },
        }),
      rendererResponse(options) {
        renderCall += 1;
        return renderCall === 1 ? emptyRenderedResponse(options) : renderedResponse(options);
      },
      clock: (call) =>
        [
          NOW,
          NOW,
          NOW,
          NOW + 10_000,
          NOW + 22_000,
          NOW + 34_000,
          NOW + 42_000,
          NOW + 42_000,
          NOW + 42_100,
        ][call]!,
    });

    const result = await execute(harness);

    expect(result.response.status).toBe(200);
    expect(harness.controls.rendererCalls).toHaveLength(2);
    expect(harness.controls.rendererCalls.map(({ options }) => options.url)).toEqual([
      'https://www.threads.com/@alice/post/Abcde/media',
      'https://www.threads.com/@alice/post/Abcde/media',
    ]);
    expect(harness.controls.probeRequests).toHaveLength(1);
    expect(harness.controls.vaultBodies).toHaveLength(1);
  });

  it.each([
    [
      'valid empty result',
      (options: RenderedBrowserScrapeOptions) => emptyRenderedResponse(options),
      422,
      'MEDIA_NOT_FOUND',
      2,
    ],
    [
      'provider failure status',
      () =>
        new Response('private-provider-error', {
          status: 429,
          headers: { 'content-type': 'application/json' },
        }),
      503,
      'RESOLVE_UNAVAILABLE',
      1,
    ],
  ] as const)(
    'maps renderer $0 to a safe public error',
    async (_name, rendererResponse, status, code, rendererCalls) => {
      const harness = createHarness({
        markupResponse: () =>
          new Response('<noscript>Enable JavaScript because JavaScript is required.</noscript>', {
            headers: { 'content-type': 'text/html' },
          }),
        rendererResponse,
      });

      const result = await execute(harness);

      expect(result.response.status).toBe(status);
      expectError(result.body, code);
      expect(harness.controls.rendererCalls).toHaveLength(rendererCalls);
      expect(harness.controls.probeRequests).toEqual([]);
      expect(harness.controls.vaultBodies).toEqual([]);
      expectPublicBodySafe(result.body, ['private-provider-error']);
    },
  );

  it.each([
    ['login', () => new Response(null, { status: 401 })],
    ['access denial', () => new Response(null, { status: 403 })],
    ['rate limit', () => new Response(null, { status: 429 })],
    [
      'bot block',
      () =>
        new Response('<main>Automated behavior was temporarily blocked.</main>', {
          headers: { 'content-type': 'text/html' },
        }),
    ],
    [
      'invalid redirect',
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://attacker.example/private-redirect' },
        }),
    ],
  ] as const)(
    'does not use rendering to bypass a Threads %s error',
    async (_name, markupResponse) => {
      const harness = createHarness({ rendererEnabled: true, markupResponse });

      const result = await execute(harness);

      expect(result.response.status).not.toBe(200);
      expect(harness.controls.rendererCalls).toEqual([]);
      expect(harness.controls.probeRequests).toEqual([]);
      expect(harness.controls.vaultBodies).toEqual([]);
      expectPublicBodySafe(result.body, ['private-redirect']);
    },
  );

  it('keeps the original safe upstream failure when the optional Browser binding is absent', async () => {
    const harness = createHarness({
      markupResponse: () => Promise.reject(new Error('private markup transport')),
    });

    const result = await execute(harness);

    expect(result.response.status).toBe(503);
    expectError(result.body, 'RESOLVE_UNAVAILABLE');
    expect(harness.controls.rendererCalls).toEqual([]);
    expect(harness.controls.failureEvents).toEqual([
      { requestId: REQUEST_ID, stage: 'resolve', code: 'THREADS_UPSTREAM_UNAVAILABLE' },
    ]);
    expectPublicBodySafe(result.body, ['private markup transport']);
  });

  it('accepts each exact 60-second lease budget boundary through rendered probe and vault store', async () => {
    const harness = createHarness({
      rendererEnabled: true,
      markupResponse: () =>
        new Response('<noscript>Enable JavaScript because JavaScript is required.</noscript>', {
          headers: { 'content-type': 'text/html' },
        }),
      clock(call) {
        return [
          NOW,
          NOW,
          NOW,
          NOW + 22_000,
          NOW + 34_000,
          NOW + 42_000,
          NOW + 42_000,
          NOW + 42_100,
        ][call]!;
      },
    });

    const result = await execute(harness);

    expect(result.response.status).toBe(200);
    expect(harness.controls.rendererCalls).toHaveLength(1);
    expect(harness.controls.probeRequests).toHaveLength(1);
    expect(harness.controls.vaultBodies).toHaveLength(1);
  });

  it('does not retry when the fixed permit cannot cover a second rendered budget', async () => {
    const harness = createHarness({
      markupResponse: () =>
        new Response('<noscript>Enable JavaScript because JavaScript is required.</noscript>', {
          headers: { 'content-type': 'text/html' },
        }),
      rendererResponse: (options) => emptyRenderedResponse(options),
      clock: (call) => [NOW, NOW, NOW, NOW + 10_000, NOW + 22_001][call]!,
    });

    const result = await execute(harness);

    expect(result.response.status).toBe(422);
    expectError(result.body, 'MEDIA_NOT_FOUND');
    expect(harness.controls.rendererCalls).toHaveLength(1);
    expect(harness.controls.probeRequests).toEqual([]);
    expect(harness.controls.vaultBodies).toEqual([]);
  });

  it.each([
    ['before rendering', [NOW, NOW, NOW, NOW + 22_001], 422, 'THREADS_JAVASCRIPT_REQUIRED', 0, 0],
    [
      'after rendering',
      [NOW, NOW, NOW, NOW + 22_000, NOW + 34_001],
      503,
      'RESOLVE_UNAVAILABLE',
      1,
      0,
    ],
    [
      'after probing',
      [NOW, NOW, NOW, NOW + 22_000, NOW + 34_000, NOW + 42_001],
      503,
      'RESOLVE_UNAVAILABLE',
      1,
      1,
    ],
  ] as const)(
    'fails closed $0 when the fixed permit has one millisecond too little',
    async (_name, values, status, code, rendererCalls, probeCalls) => {
      const harness = createHarness({
        rendererEnabled: true,
        markupResponse: () =>
          new Response('<noscript>Enable JavaScript because JavaScript is required.</noscript>', {
            headers: { 'content-type': 'text/html' },
          }),
        clock: (call) => values[call]!,
      });

      const result = await execute(harness);

      expect(result.response.status).toBe(status);
      expectError(result.body, code);
      expect(harness.controls.rendererCalls).toHaveLength(rendererCalls);
      expect(harness.controls.probeRequests).toHaveLength(probeCalls);
      expect(harness.controls.vaultBodies).toEqual([]);
    },
  );

  it.each([
    [() => new Response(null, { status: 404 }), 422, 'MEDIA_NOT_FOUND'],
    [() => Promise.reject(new Error('private probe transport')), 503, 'RESOLVE_UNAVAILABLE'],
  ] as const)(
    'classifies an all-failed probe batch safely',
    async (probeResponse, status, code) => {
      const harness = createHarness({ probeResponse });
      const result = await execute(harness);

      expect(result.response.status).toBe(status);
      expectError(result.body, code);
      expect(harness.controls.vaultBodies).toEqual([]);
      expect(releaseCounts(harness.controls)).toEqual({ session: 1, ip: 1 });
      expectPublicBodySafe(result.body, ['private probe transport']);
    },
  );
});

describe('resolve public media typed failures', () => {
  it.each([
    ['replayed Turnstile', { replayStatus: 409 }, 403, 'TURNSTILE_INVALID'],
    [
      'invalid Turnstile',
      { siteverifyResponse: () => jsonResponse({ success: false }) },
      403,
      'TURNSTILE_INVALID',
    ],
    [
      'unavailable Turnstile',
      { siteverifyResponse: () => new Response(null, { status: 503 }) },
      503,
      'TURNSTILE_UNAVAILABLE',
    ],
  ] as const)('never calls Browser Run after $0', async (_name, options, status, code) => {
    const harness = createHarness({ ...options, rendererEnabled: true });
    const result = await execute(harness);

    expect(result.response.status).toBe(status);
    expectError(result.body, code);
    expect(harness.controls.rendererCalls).toEqual([]);
    expect(harness.controls.sequence).not.toContain('threads:markup');
  });

  it.each([
    ['Turnstile replay', { replayStatus: 409 }, 403, 'TURNSTILE_INVALID'],
    [
      'Turnstile rejection',
      { siteverifyResponse: () => jsonResponse({ success: false }) },
      403,
      'TURNSTILE_INVALID',
    ],
    [
      'Turnstile outage',
      { siteverifyResponse: () => new Response(null, { status: 503 }) },
      503,
      'TURNSTILE_UNAVAILABLE',
    ],
    [
      'Threads login',
      { markupResponse: () => new Response(null, { status: 401 }) },
      422,
      'THREADS_LOGIN_REQUIRED',
    ],
    [
      'Threads denial',
      { markupResponse: () => new Response(null, { status: 403 }) },
      403,
      'THREADS_ACCESS_DENIED',
    ],
    [
      'Threads throttling',
      { markupResponse: () => new Response(null, { status: 429 }) },
      429,
      'THREADS_RATE_LIMITED',
    ],
    [
      'Threads bot block',
      {
        markupResponse: () =>
          new Response('<main>Automated behavior was temporarily blocked.</main>', {
            headers: { 'content-type': 'text/html' },
          }),
      },
      503,
      'THREADS_BOT_BLOCKED',
    ],
    [
      'Threads JavaScript shell',
      {
        markupResponse: () =>
          new Response('<noscript>Enable JavaScript because JavaScript is required.</noscript>', {
            headers: { 'content-type': 'text/html' },
          }),
      },
      422,
      'THREADS_JAVASCRIPT_REQUIRED',
    ],
    [
      'missing media',
      {
        markupResponse: () =>
          new Response('<main>Public post without downloadable media.</main>', {
            headers: { 'content-type': 'text/html' },
          }),
      },
      422,
      'MEDIA_NOT_FOUND',
    ],
    [
      'invalid markup response',
      {
        markupResponse: () =>
          new Response('{"private":"response"}', {
            headers: { 'content-type': 'application/json' },
          }),
      },
      503,
      'RESOLVE_UNAVAILABLE',
    ],
  ] as const)(
    'maps $0 and releases both permits exactly once',
    async (_name, options, status, code) => {
      const harness = createHarness(options);
      const result = await execute(harness);

      expect(result.response.status).toBe(status);
      expectError(result.body, code);
      expect(releaseCounts(harness.controls)).toEqual({ session: 1, ip: 1 });
      expectPublicBodySafe(result.body, ['private']);
    },
  );

  it.each([
    [401, 401, 'SESSION_INVALID'],
    [429, 429, 'RATE_LIMITED'],
    [409, 503, 'RESOLVE_UNAVAILABLE'],
    [500, 503, 'RESOLVE_UNAVAILABLE'],
  ] as const)(
    'maps vault status %s and releases exactly once',
    async (vaultStatus, status, code) => {
      const harness = createHarness({
        vaultResponse: () => jsonResponse({ ok: false, private: POST_URL }, vaultStatus),
      });
      const result = await execute(harness);

      expect(result.response.status).toBe(status);
      expectError(result.body, code);
      expect(releaseCounts(harness.controls)).toEqual({ session: 1, ip: 1 });
      expectPublicBodySafe(result.body);
    },
  );

  it.each([
    [{ sessionAcquireStatus: 401 }, 401, 'SESSION_INVALID', []],
    [{ sessionAcquireStatus: 429 }, 429, 'RATE_LIMITED', []],
    [{ sessionAcquireStatus: 503 }, 503, 'RESOLVE_UNAVAILABLE', []],
    [{ ipAcquireStatus: 429 }, 429, 'RATE_LIMITED', ['session:release']],
    [{ ipAcquireStatus: 503 }, 503, 'RESOLVE_UNAVAILABLE', ['session:release']],
  ] as const)(
    'maps acquisition failure without releasing a nonexistent public lease',
    async (options, status, code, rollback) => {
      const harness = createHarness({ ...options, rendererEnabled: true });
      const result = await execute(harness);

      expect(result.response.status).toBe(status);
      expectError(result.body, code);
      expect(harness.controls.sequence.filter((entry) => entry.endsWith(':release'))).toEqual(
        rollback,
      );
      expect(harness.controls.sequence).not.toContain('turnstile:reserve');
      expect(harness.controls.rendererCalls).toEqual([]);
      expectPublicBodySafe(result.body);
    },
  );

  it('fails closed on a missing trusted client IP and releases only the partial acquisition', async () => {
    const harness = createHarness();
    const result = await execute(harness, { ip: null });

    expect(result.response.status).toBe(503);
    expectError(result.body, 'RESOLVE_UNAVAILABLE');
    expect(harness.controls.sequence).toEqual(['session:acquire', 'session:release']);
  });

  it('uses a fixed safe 500 envelope for unexpected failures before acquisition', async () => {
    const harness = createHarness({ clockError: 'private stack and secret detail' });
    const result = await execute(harness);

    expect(result.response.status).toBe(500);
    expectError(result.body, 'INTERNAL_ERROR');
    expect(harness.controls.sequence).toEqual([]);
    expectPublicBodySafe(result.body, ['private stack and secret detail']);
  });
});

describe('resolve public media failure telemetry', () => {
  it.each([
    ['limits', { sessionAcquireStatus: 503 }, 'admission', 'RESOLVE_LIMITS_UNAVAILABLE', undefined],
    [
      'renderer',
      {
        markupResponse: () =>
          new Response('<noscript>Enable JavaScript because JavaScript is required.</noscript>', {
            headers: { 'content-type': 'text/html' },
          }),
        rendererResponse: () =>
          new Response('private-provider-error', {
            status: 429,
            headers: { 'content-type': 'application/json' },
          }),
      },
      'resolve',
      'RENDERED_UNAVAILABLE',
      undefined,
    ],
    [
      'probe',
      { probeResponse: () => Promise.reject(new Error('private probe transport')) },
      'resolve',
      'MEDIA_PROBE_UNAVAILABLE',
      'cdninstagram',
    ],
    [
      'vault',
      { vaultResponse: () => jsonResponse({ ok: false, private: POST_URL }, 500) },
      'resolve',
      'RESOLVE_VAULT_UNAVAILABLE',
      undefined,
    ],
  ] as const)(
    'reports one exact PII-free event for a 5xx $0 failure',
    async (_name, options, stage, code, family) => {
      const harness = createHarness(options);
      const result = await execute(harness);

      expect(result.response.status).toBe(503);
      expect(harness.controls.failureEvents).toEqual([
        {
          requestId: REQUEST_ID,
          stage,
          code,
          ...(family === undefined ? {} : { candidateFamily: family }),
        },
      ]);
      expect(Object.keys(harness.controls.failureEvents[0]!).sort()).toEqual(
        family === undefined
          ? ['code', 'requestId', 'stage']
          : ['candidateFamily', 'code', 'requestId', 'stage'],
      );
      expectFailureEventsSafe(harness.controls.failureEvents, [
        'private-provider-error',
        'private probe transport',
      ]);
    },
  );

  it('reports an unexpected prepare failure without exposing its details', async () => {
    const harness = createHarness();
    const bindings = { ...harness.bindings, SESSION_SIGNING_KEY: 'private invalid signing key' };
    const response = await createResolvePublicMediaHandler(harness.runtime)(
      await resolveRequest(),
      bindings,
    );
    const body = await response.text();

    expect(response.status).toBe(500);
    expectError(body, 'INTERNAL_ERROR');
    expect(harness.controls.failureEvents).toEqual([
      { requestId: REQUEST_ID, stage: 'prepare', code: 'UNEXPECTED_ERROR' },
    ]);
    expectFailureEventsSafe(harness.controls.failureEvents, ['private invalid signing key']);
  });

  it.each([
    ['cdninstagram', defaultUrls(2), 'cdninstagram'],
    ['Instagram FNA', PRIVATE_FNA_URLS, 'instagram-fna'],
  ] as const)(
    'classifies a homogeneous failed %s probe batch without retaining its host',
    async (_name, markupUrls, candidateFamily) => {
      const harness = createHarness({
        markupUrls,
        probeResponse: () => Promise.reject(new Error('private homogeneous probe failure')),
      });
      const result = await execute(harness);

      expect(result.response.status).toBe(503);
      expect(harness.controls.failureEvents).toEqual([
        {
          requestId: REQUEST_ID,
          stage: 'resolve',
          code: 'MEDIA_PROBE_UNAVAILABLE',
          candidateFamily,
        },
      ]);
      expectFailureEventsSafe(harness.controls.failureEvents, [
        'private homogeneous probe failure',
        ...markupUrls,
        'video.cdninstagram.com',
        'instagram.ftpe7-2.fna.fbcdn.net',
      ]);
    },
  );

  it('omits candidate family when failed probes span both allowed families', async () => {
    const markupUrls = [defaultUrls(1)[0]!, PRIVATE_FNA_URLS[0]];
    const harness = createHarness({
      markupUrls,
      probeResponse: () => Promise.reject(new Error('private mixed probe failure')),
    });
    const result = await execute(harness);

    expect(result.response.status).toBe(503);
    expect(harness.controls.failureEvents).toEqual([
      { requestId: REQUEST_ID, stage: 'resolve', code: 'MEDIA_PROBE_UNAVAILABLE' },
    ]);
    expectFailureEventsSafe(harness.controls.failureEvents, [
      'private mixed probe failure',
      ...markupUrls,
    ]);
  });

  it('serializes only the exact bounded schema and strips unrelated properties', () => {
    const event = {
      requestId: REQUEST_ID,
      stage: 'resolve',
      code: 'MEDIA_PROBE_UNAVAILABLE',
      candidateFamily: 'instagram-fna',
      source: POST_URL,
      candidateUrl: PRIVATE_FNA_URLS[0],
    } as ResolveFailureEvent & { readonly candidateUrl: string; readonly source: string };
    const serialized = serializeResolveFailureEvent(event);

    expect(JSON.parse(serialized)).toEqual({
      requestId: REQUEST_ID,
      stage: 'resolve',
      code: 'MEDIA_PROBE_UNAVAILABLE',
      candidateFamily: 'instagram-fna',
    });
    expect(serialized.length).toBeLessThanOrEqual(256);
    expect(serialized).not.toContain(POST_URL);
    expect(serialized).not.toContain(PRIVATE_FNA_URLS[0]);
  });

  it.each([
    [
      'renderer empty result',
      {
        markupResponse: () =>
          new Response('<noscript>Enable JavaScript because JavaScript is required.</noscript>', {
            headers: { 'content-type': 'text/html' },
          }),
        rendererResponse: (options: RenderedBrowserScrapeOptions) =>
          jsonResponse({
            success: true,
            result: [
              ...renderedIdentity(options),
              { selector: options.elements[2]!.selector, results: [] },
              { selector: options.elements[3]!.selector, results: [] },
            ],
          }),
      },
      'RENDERED_MEDIA_NOT_FOUND',
      undefined,
    ],
    [
      'nontransient probe rejection',
      { probeResponse: () => new Response('private-probe-error', { status: 404 }) },
      'MEDIA_PROBE_STATUS_INVALID',
      'cdninstagram',
    ],
  ] as const)(
    'reports one exact PII-free event for a MEDIA_NOT_FOUND $0',
    async (_name, options, code, family) => {
      const harness = createHarness(options);
      const result = await execute(harness);

      expect(result.response.status).toBe(422);
      expectError(result.body, 'MEDIA_NOT_FOUND');
      expect(harness.controls.failureEvents).toEqual([
        {
          requestId: REQUEST_ID,
          stage: 'resolve',
          code,
          ...(family === undefined ? {} : { candidateFamily: family }),
        },
      ]);
      expect(Object.keys(harness.controls.failureEvents[0]!).sort()).toEqual(
        family === undefined
          ? ['code', 'requestId', 'stage']
          : ['candidateFamily', 'code', 'requestId', 'stage'],
      );
      expectFailureEventsSafe(harness.controls.failureEvents, ['private-probe-error']);
    },
  );

  it.each([
    ['Turnstile rejection', { replayStatus: 409 }, 403],
    ['Threads access denial', { markupResponse: () => new Response(null, { status: 403 }) }, 403],
    [
      'Threads login requirement',
      { markupResponse: () => new Response(null, { status: 401 }) },
      422,
    ],
  ] as const)('does not report an ordinary $0 4xx', async (_name, options, status) => {
    const harness = createHarness(options);
    const result = await execute(harness);

    expect(result.response.status).toBe(status);
    expect(harness.controls.failureEvents).toEqual([]);
  });

  it('preserves the safe public response when the reporter throws', async () => {
    const harness = createHarness({
      probeResponse: () => Promise.reject(new Error('private probe transport')),
      reporterThrows: true,
    });
    const result = await execute(harness);

    expect(result.response.status).toBe(503);
    expectError(result.body, 'RESOLVE_UNAVAILABLE');
    expect(harness.controls.failureEvents).toEqual([
      {
        requestId: REQUEST_ID,
        stage: 'resolve',
        code: 'MEDIA_PROBE_UNAVAILABLE',
        candidateFamily: 'cdninstagram',
      },
    ]);
    expectPublicBodySafe(result.body, ['private reporter failure', 'private probe transport']);
  });
});

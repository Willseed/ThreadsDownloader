import { describe, expect, it, vi } from 'vitest';

import {
  createResolvePublicMediaHandler,
  type ResolvePublicMediaBindings,
  type ResolvePublicMediaRuntime,
} from '../src/workflows/resolve-public-media.js';
import { SESSION_COOKIE_NAME } from '../src/security/browser-session.js';
import { createOpaqueValueSigner, importSigningKey } from '../src/security/cryptography.js';
import type { IpRateLimitNamespace } from '../src/security/resolve-limits.js';
import type { SessionNamespace } from '../src/security/session-client.js';
import type { TurnstileReplayNamespace } from '../src/security/turnstile.js';
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
const REQUEST_ID = 'public-request-id';
const RESOLVE_ID = encodeBase64Url(new Uint8Array(24).fill(3));

interface HarnessOptions {
  readonly clockError?: string;
  readonly ipAcquireStatus?: number;
  readonly markupContentType?: string;
  readonly markupResponse?: () => Response | Promise<Response>;
  readonly markupUrls?: readonly string[];
  readonly probeResponse?: (request: Request, index: number) => Response | Promise<Response>;
  readonly replayStatus?: number;
  readonly sessionAcquireStatus?: number;
  readonly siteverifyResponse?: () => Response | Promise<Response>;
  readonly vaultResponse?: (body: Record<string, unknown>) => Response | Promise<Response>;
}

interface HarnessControls {
  readonly clockValues: number[];
  readonly ipBodies: Record<string, unknown>[];
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
                ? { ok: true, expiresAt: (body['now'] as number) + 30_000 }
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
                ? { ok: true, expiresAt: (body['now'] as number) + 30_000 }
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
    if (url.hostname.endsWith('.cdninstagram.com')) {
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
    ipBodies: [],
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
      const value = NOW + clockOffset;
      clockOffset += 100;
      controls.clockValues.push(value);
      return value;
    },
    requestId: () => REQUEST_ID,
  };
  const bindings: ResolvePublicMediaBindings = {
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
      const harness = createHarness();
      const result = await execute(harness, input);

      expect(result.response.status).toBe(status);
      expect(result.response.headers.get('cache-control')).toBe('no-store');
      expectError(result.body, code);
      expectPublicBodySafe(result.body);
      expect(harness.controls.sequence).toEqual([]);
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
    const badCookie = createHarness();
    const cookieResult = await execute(badCookie, {
      cookie: `${SESSION_COOKIE_NAME}=tampered.private-cookie`,
    });
    expect(cookieResult.response.status).toBe(401);
    expectError(cookieResult.body, 'SESSION_INVALID');
    expect(badCookie.controls.sequence).toEqual([]);

    const badUrl = createHarness();
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
      probeResponse: async (_request, index) => {
        if (index === 1) {
          return new Response(null, { status: 404 });
        }
        if (index === 2) {
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
      const harness = createHarness(options);
      const result = await execute(harness);

      expect(result.response.status).toBe(status);
      expectError(result.body, code);
      expect(harness.controls.sequence.filter((entry) => entry.endsWith(':release'))).toEqual(
        rollback,
      );
      expect(harness.controls.sequence).not.toContain('turnstile:reserve');
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

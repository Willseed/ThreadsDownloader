import { describe, expect, it, vi } from 'vitest';

import worker, { type Env } from '../src/index.js';
import {
  createIpRateLimitNamespace,
  createSessionNamespace,
} from './support/session-namespaces.js';

const expectedHost = 'threads.example.test';
const downloadEncryptionKey = 'A'.repeat(43);
const signingKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const turnstileSiteKey = 'test-site-key';

function createEnv(
  assetResponse = new Response('<app-root></app-root>', { status: 200 }),
  sessions = createSessionNamespace(),
  downloadSessions = {} as Env['DOWNLOAD_SESSIONS'],
  ipRateLimits: Env['IP_RATE_LIMITS'] = createIpRateLimitNamespace() as unknown as Env['IP_RATE_LIMITS'],
): Env {
  return {
    DOWNLOAD_ENCRYPTION_KEY: downloadEncryptionKey,
    DOWNLOAD_SESSIONS: downloadSessions,
    EXPECTED_HOST: expectedHost,
    EXPECTED_ORIGIN: `https://${expectedHost}`,
    IP_RATE_LIMITS: ipRateLimits,
    RESOLVED_MEDIA_GRANT_KEY: signingKey,
    SESSION_SIGNING_KEY: signingKey,
    SESSIONS: sessions,
    TURNSTILE_REPLAYS: {} as Env['TURNSTILE_REPLAYS'],
    TURNSTILE_SECRET: crypto.randomUUID(),
    TURNSTILE_SITE_KEY: turnstileSiteKey,
    ASSETS: { fetch: vi.fn(async () => assetResponse) },
  };
}

function createDownloadSessionNamespace(
  handler: (request: Request) => Promise<Response>,
): Env['DOWNLOAD_SESSIONS'] {
  return {
    idFromName(name) {
      return { name } as unknown as DurableObjectId;
    },
    get() {
      return { fetch: handler };
    },
  };
}

async function fetchWorker(path: string, env = createEnv()): Promise<Response> {
  return worker.fetch(
    new Request(`https://${expectedHost}${path}`, {
      headers: { 'CF-Connecting-IP': '203.0.113.42' },
    }),
    env,
    {} as ExecutionContext,
  );
}

describe('worker entry policy', () => {
  it('returns a typed health response for the allowed host', async () => {
    const response = await fetchWorker('/api/health');

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toMatchObject({ status: 'ok' });
  });

  it('routes session issuance through Hono and applies the worker response policy', async () => {
    const env = createEnv();
    const response = await fetchWorker('/api/session', env);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('set-cookie')).toContain('__Host-td_session=');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    await expect(response.json()).resolves.toMatchObject({ turnstileSiteKey });
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it.each([
    'https://preview.threads.example.test/api/health',
    'https://example.workers.dev/api/health',
    'http://localhost:8787/api/health',
    'http://127.0.0.1/api/health',
  ])('blocks an unexpected hostname: %s', async (url) => {
    const response = await worker.fetch(
      new Request(url, { headers: { 'x-forwarded-host': expectedHost } }),
      createEnv(),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe('Not Found');
  });

  it.each(['/api', '/api/missing'])(
    'keeps the root and unknown API 404 outside the download route shape: %s',
    async (path) => {
      const env = createEnv();
      const response = await fetchWorker(path, env);

      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('content-type')).toBe('application/json');
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'NOT_FOUND', message: '找不到請求的 API 路徑。' },
      });
      expect(env.ASSETS.fetch).not.toHaveBeenCalled();
    },
  );

  it('delegates a download route shape while preserving its legacy JSON and HEAD 404s', async () => {
    const env = createEnv();
    const path = `/api/download/${'A'.repeat(32)}?debug=1`;
    const response = await fetchWorker(path, env);
    const headResponse = await worker.fetch(
      new Request(`https://${expectedHost}${path}`, { method: 'HEAD' }),
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toBe('application/json; charset=UTF-8');
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(headResponse.status).toBe(404);
    expect(headResponse.body).toBeNull();
    expect(headResponse.headers.get('content-type')).toBe('application/json; charset=UTF-8');
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it('routes Hono HEAD through inspect only and preserves metadata with a null body', async () => {
    const inspectRequests: Request[] = [];
    const sessions = createSessionNamespace();
    const env = createEnv(
      undefined,
      sessions,
      createDownloadSessionNamespace(async (request) => {
        inspectRequests.push(request.clone() as unknown as Request);
        return new Response(null, {
          status: 200,
          headers: {
            'access-control-allow-origin': '*',
            'content-length': '100',
            'content-type': 'video/mp4',
            etag: '"strong-v1"',
            'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT',
            'x-download-filename': 'threads_Abcde_1.mp4',
            'x-download-range-capability': 'bytes',
          },
        });
      }),
    );
    const session = await fetchWorker('/api/session', env);
    const cookie = session.headers.get('set-cookie')!.split(';', 1)[0]!;
    const downloadId = 'A'.repeat(32);
    const response = await worker.fetch(
      new Request(`https://${expectedHost}/api/download/${downloadId}`, {
        method: 'HEAD',
        headers: { cookie, range: 'bytes=10-19', 'if-range': '"strong-v1"' },
      }),
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-length')).toBe('100');
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="threads_Abcde_1.mp4"',
    );
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(inspectRequests).toHaveLength(1);
    expect(inspectRequests[0]?.method).toBe('HEAD');
    expect(new URL(inspectRequests[0]!.url).pathname).toBe('/inspect');
    expect(inspectRequests[0]?.headers.get('range')).toBeNull();
    expect(inspectRequests[0]?.headers.get('if-range')).toBeNull();
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it('keeps Hono HEAD failures bodyless without touching download state', async () => {
    const downloadFetch = vi.fn(async () => Response.json({ ok: true }));
    const env = createEnv(
      undefined,
      createSessionNamespace(),
      createDownloadSessionNamespace(downloadFetch),
    );
    const response = await worker.fetch(
      new Request(`https://${expectedHost}/api/download/${'A'.repeat(32)}`, {
        method: 'HEAD',
        headers: { cookie: '__Host-td_session=tampered.signature' },
      }),
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(401);
    expect(response.body).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(downloadFetch).not.toHaveBeenCalled();
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it('routes canonical download GET before catch-all while wrong methods remain API 404', async () => {
    const env = createEnv();
    const path = `/api/download/${'A'.repeat(32)}`;
    const getResponse = await fetchWorker(path, env);
    expect(getResponse.status).toBe(401);
    await expect(getResponse.json()).resolves.toMatchObject({
      error: { code: 'SESSION_INVALID' },
    });

    const wrongMethod = await worker.fetch(
      new Request(`https://${expectedHost}${path}`, { method: 'DELETE' }),
      env,
      {} as ExecutionContext,
    );
    expect(wrongMethod.status).toBe(404);
    expect(wrongMethod.headers.get('cache-control')).toBe('no-store');
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it('routes canonical preview GET before catch-all without touching assets', async () => {
    const env = createEnv();
    const capability = `v1.${'A'.repeat(16)}.${'A'.repeat(22)}`;
    const response = await fetchWorker(`/api/preview/${capability}`, env);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'SESSION_INVALID' },
    });
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it('routes resolve mutations before the API catch-all without touching assets', async () => {
    const env = createEnv();
    const response = await worker.fetch(
      new Request(`https://${expectedHost}/api/resolve`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: `https://${expectedHost}`,
        },
        body: '{}',
      }),
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'REQUEST_INVALID', message: '請求格式不正確。' },
    });
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it('uses the asset binding for non-API paths without a recursive fetch', async () => {
    const env = createEnv();
    const response = await fetchWorker('/about', env);

    expect(response.status).toBe(200);
    expect(env.ASSETS.fetch).toHaveBeenCalledTimes(1);
  });

  it('adds the required security policy and never enables CORS', async () => {
    const env = createEnv(
      new Response('asset', {
        headers: { 'access-control-allow-origin': '*', 'content-type': 'text/html' },
      }),
    );
    const response = await fetchWorker('/', env);
    const contentSecurityPolicy = response.headers.get('content-security-policy');

    expect(contentSecurityPolicy).toBe(
      "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; " +
        "script-src 'self' https://challenges.cloudflare.com https://static.cloudflareinsights.com; " +
        "style-src 'self'; frame-src https://challenges.cloudflare.com; connect-src 'self'; " +
        "media-src 'self' https://cdninstagram.com https://*.cdninstagram.com https://*.fna.fbcdn.net",
    );
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('strict-transport-security')).toBe('max-age=31536000');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('copies immutable-like asset headers without buffering or losing response metadata', async () => {
    const assetResponse = new Response('immutable asset', {
      headers: {
        'access-control-allow-headers': '*',
        'access-control-allow-origin': '*',
        'content-type': 'text/plain',
        'x-asset-version': 'v7',
      },
      status: 206,
      statusText: 'Partial Content',
    });
    const originalBody = assetResponse.body;
    Object.defineProperties(assetResponse.headers, {
      delete: {
        value: () => {
          throw new TypeError('immutable headers');
        },
      },
      set: {
        value: () => {
          throw new TypeError('immutable headers');
        },
      },
    });

    const response = await fetchWorker('/', createEnv(assetResponse));

    expect(response.status).toBe(206);
    expect(response.statusText).toBe('Partial Content');
    expect(response.body).toBe(originalBody);
    expect(response.headers.get('x-asset-version')).toBe('v7');
    expect(response.headers.get('access-control-allow-headers')).toBeNull();
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    await expect(response.text()).resolves.toBe('immutable asset');
  });

  it('returns a safe JSON envelope when an unexpected failure occurs', async () => {
    const env = createEnv();
    vi.mocked(env.ASSETS.fetch).mockRejectedValueOnce(
      new Error('internal stack detail and vault-secret-value'),
    );

    const response = await fetchWorker('/', env);
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(JSON.parse(body)).toMatchObject({
      error: { code: 'INTERNAL_ERROR', message: '伺服器暫時無法處理請求。' },
    });
    expect(body).not.toContain('stack');
    expect(body).not.toContain('vault-secret-value');
  });
});

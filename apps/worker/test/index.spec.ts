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

  it.each([
    [`/api/download/${'A'.repeat(32)}?debug=1`, 'GET'],
    [`/api/download/%41${'A'.repeat(31)}`, 'GET'],
    [`/api/download/A%2F${'A'.repeat(30)}`, 'GET'],
    [`/api/%64ownload/${'A'.repeat(32)}`, 'GET'],
    [`/%61pi/download/${'A'.repeat(32)}`, 'GET'],
    ['/api/%64ownload-sessions', 'POST'],
    ['/%61pi/preview-sessions', 'POST'],
  ] as const)(
    'keeps a normalized download family inside the handler-owned JSON 404: %s %s',
    async (path, method) => {
      const env = createEnv();
      const response = await worker.fetch(
        new Request(`https://${expectedHost}${path}`, { method }),
        env,
        {} as ExecutionContext,
      );

      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('content-type')).toBe('application/json; charset=UTF-8');
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'NOT_FOUND' } });
      expect(env.ASSETS.fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    [`/api/preview/v1.${'A'.repeat(16)}.${'A'.repeat(22)}`, 'HEAD'],
    [`/api/download-status/${'A'.repeat(32)}`, 'HEAD'],
  ] as const)('keeps an owned non-download HEAD route bodyless: %s', async (path, method) => {
    const env = createEnv();
    const response = await worker.fetch(
      new Request(`https://${expectedHost}${path}`, { method }),
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(404);
    expect(response.body).toBeNull();
    expect(response.headers.get('content-type')).toBe('application/json; charset=UTF-8');
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it.each([
    [`/api/download/${'A'.repeat(32)}/`, 'GET'],
    [`/api/download/${'A'.repeat(32)}/extra`, 'GET'],
    ['/api/download/', 'GET'],
    ['/api/missing', 'GET'],
    ['/api/missing', 'HEAD'],
    [`/api/download/${'A'.repeat(32)}`, 'DELETE'],
  ] as const)(
    'keeps a generic API route in the generic JSON fallback: %s %s',
    async (path, method) => {
      const env = createEnv();
      const response = await worker.fetch(
        new Request(`https://${expectedHost}${path}`, { method }),
        env,
        {} as ExecutionContext,
      );

      expect(response.status).toBe(404);
      if (method === 'HEAD') {
        expect(response.body).toBeNull();
      } else {
        expect(response.body).not.toBeNull();
      }
      expect(response.headers.get('content-type')).toBe('application/json');
      expect(env.ASSETS.fetch).not.toHaveBeenCalled();
    },
  );

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

  it('serves machine-readable agent discovery files on dedicated endpoints', async () => {
    const env = createEnv();
    const robots = await fetchWorker('/robots.txt', env);
    const sitemap = await fetchWorker('/sitemap.xml', env);
    const apiCatalog = await fetchWorker('/.well-known/api-catalog', env);
    const mcpServerCard = await fetchWorker('/.well-known/mcp.json', env);
    const agentSkills = await fetchWorker('/.well-known/agent-skills/index.json', env);
    const agentCard = await fetchWorker('/.well-known/agent-card.json', env);
    const oauthProtectedResource = await fetchWorker('/.well-known/oauth-protected-resource', env);
    const authMd = await fetchWorker('/auth.md', env);

    expect(robots.status).toBe(200);
    expect(robots.headers.get('content-type')).toBe('text/plain');
    expect(await robots.text()).toContain('Content-Signal: ai-train=yes');

    expect(sitemap.status).toBe(200);
    expect(sitemap.headers.get('content-type')).toBe('application/xml');
    expect(await sitemap.text()).toContain('<urlset');

    expect(apiCatalog.status).toBe(200);
    expect(apiCatalog.headers.get('content-type')).toBe('application/json');
    const apiCatalogJson = await apiCatalog.json();
    expect(apiCatalogJson).toMatchObject({
      linkset: [
        {
          'service-desc': [
            {
              href: 'https://threads.pylot.dev/.well-known/mcp.json',
              type: 'application/json',
            },
          ],
        },
      ],
    });

    expect(await mcpServerCard.json()).toMatchObject({
      serverInfo: { name: 'Threads Downloader' },
      transport: { type: 'streamable-http' },
    });

    expect(await agentSkills.json()).toMatchObject({
      $schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json',
    });
    expect(agentSkills.status).toBe(200);

    const agentCardJson = await agentCard.json();
    expect(agentCardJson).toMatchObject({
      name: 'Threads Downloader',
      skills: [
        {
          id: 'threads-public-download',
          name: 'threads-public-download',
        },
      ],
    });
    expect(agentCard.headers.get('content-type')).toBe('application/json');
    expect(agentCard.status).toBe(200);

    expect(oauthProtectedResource.status).toBe(200);
    expect(oauthProtectedResource.headers.get('content-type')).toBe('application/json');
    expect(await oauthProtectedResource.json()).toMatchObject({
      resource: 'https://threads.pylot.dev',
      authorization_servers: ['https://threads.pylot.dev'],
      scopes_supported: ['public:read'],
      bearer_methods_supported: ['header'],
    });

    const authMdBody = await authMd.text();
    expect(authMdBody).toContain('## Agent registration');
    expect(authMdBody).toContain('agent_auth');
    expect(authMd.status).toBe(200);
    expect(authMd.headers.get('content-type')).toBe('text/markdown');

    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it('supports Markdown negotiation on the homepage and adds Link headers', async () => {
    const env = createEnv(new Response('<!doctype html><title>Threads Downloader</title>'));
    const response = await fetchWorker('/', env);
    const markdownResponse = await worker.fetch(
      new Request(`https://${expectedHost}/`, {
        headers: { accept: 'text/markdown' },
      }),
      env,
      {} as ExecutionContext,
    );
    const markdownBody = await markdownResponse.text();

    expect(response.headers.get('link')).toContain('</.well-known/api-catalog>');
    expect(markdownResponse.headers.get('content-type')).toBe('text/markdown');
    expect(markdownBody).toContain('# Threads Downloader');
    expect(markdownResponse.status).toBe(200);
    expect(env.ASSETS.fetch).toHaveBeenCalledTimes(1);
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

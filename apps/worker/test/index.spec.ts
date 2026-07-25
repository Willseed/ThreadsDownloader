import { describe, expect, it, vi } from 'vitest';

import worker, { authorizeSession, type Env, type SessionNamespace } from '../src/index.js';

const expectedHost = 'threads.example.test';
const downloadEncryptionKey = 'A'.repeat(43);
const signingKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const turnstileSiteKey = 'test-site-key';

interface FakeSessionRecord {
  readonly sessionHash: string;
  readonly csrfHash: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

function createSessionNamespace(requests: unknown[] = [], responseStatus = 200): SessionNamespace {
  const ids = new Map<DurableObjectId, string>();
  const records = new Map<string, FakeSessionRecord>();
  return {
    idFromName(name) {
      const id = {} as DurableObjectId;
      ids.set(id, name);
      return id;
    },
    get(id) {
      const name = ids.get(id)!;
      return {
        async fetch(request) {
          const pathname = new URL(request.url).pathname;
          expect(request.method).toBe('POST');
          expect(['/authorize', '/bootstrap']).toContain(pathname);
          const body: unknown = await request.json();
          requests.push(body);
          if (responseStatus !== 200) {
            return Response.json({ ok: false }, { status: responseStatus });
          }
          if (pathname === '/authorize') {
            return Response.json({ ok: true });
          }
          const input = body as FakeSessionRecord;
          const current = records.get(name);
          const stored = current ?? input;
          records.set(name, { ...stored, csrfHash: input.csrfHash });
          return Response.json({ ok: true, expiresAt: stored.expiresAt });
        },
      };
    },
  };
}

function createEnv(
  assetResponse = new Response('<app-root></app-root>', { status: 200 }),
  sessions = createSessionNamespace(),
): Env {
  return {
    DOWNLOAD_ENCRYPTION_KEY: downloadEncryptionKey,
    DOWNLOAD_SESSIONS: {} as Env['DOWNLOAD_SESSIONS'],
    EXPECTED_HOST: expectedHost,
    EXPECTED_ORIGIN: `https://${expectedHost}`,
    IP_RATE_LIMITS: {} as Env['IP_RATE_LIMITS'],
    RESOLVED_MEDIA_GRANT_KEY: signingKey,
    SESSION_SIGNING_KEY: signingKey,
    SESSIONS: sessions,
    TURNSTILE_REPLAYS: {} as Env['TURNSTILE_REPLAYS'],
    TURNSTILE_SECRET: crypto.randomUUID(),
    TURNSTILE_SITE_KEY: turnstileSiteKey,
    ASSETS: { fetch: vi.fn(async () => assetResponse) },
  };
}

async function fetchWorker(path: string, env = createEnv()): Promise<Response> {
  return worker.fetch(new Request(`https://${expectedHost}${path}`), env, {} as ExecutionContext);
}

describe('worker entry policy', () => {
  it('returns a typed health response for the allowed host', async () => {
    const response = await fetchWorker('/api/health');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'ok' });
  });

  it('creates an anonymous session without exposing internal identifiers', async () => {
    const requests: unknown[] = [];
    const response = await fetchWorker(
      '/api/session',
      createEnv(undefined, createSessionNamespace(requests)),
    );
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('set-cookie')).toContain('__Host-td_session=');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(text).toContain('csrfToken');
    expect(text).toContain('expiresAt');
    expect(text).toContain(turnstileSiteKey);
    expect(text).not.toContain('sessionHash');
    expect(text).not.toContain('rawId');
    expect(requests).toHaveLength(1);
    expect(Object.keys(requests[0] as Record<string, unknown>).sort()).toEqual([
      'csrfHash',
      'expiresAt',
      'issuedAt',
      'sessionHash',
    ]);
  });

  it('reuses a valid cookie while rotating CSRF without resetting the cookie', async () => {
    const sessions = createSessionNamespace();
    const env = createEnv(undefined, sessions);
    const first = await fetchWorker('/api/session', env);
    const firstBody = (await first.json()) as { csrfToken: string; expiresAt: string };
    const cookie = first.headers.get('set-cookie')!.split(';', 1)[0]!;

    const next = await worker.fetch(
      new Request(`https://${expectedHost}/api/session`, { headers: { cookie } }),
      env,
      {} as ExecutionContext,
    );
    const nextBody = (await next.json()) as { csrfToken: string; expiresAt: string };
    expect(next.headers.get('set-cookie')).toBeNull();
    expect(nextBody.csrfToken).not.toBe(firstBody.csrfToken);
    expect(nextBody.expiresAt).toBe(firstBody.expiresAt);
  });

  it('replaces a tampered cookie and returns a safe internal denial', async () => {
    const replacement = await worker.fetch(
      new Request(`https://${expectedHost}/api/session`, {
        headers: { cookie: '__Host-td_session=tampered.secret' },
      }),
      createEnv(),
      {} as ExecutionContext,
    );
    expect(replacement.status).toBe(200);
    expect(replacement.headers.get('set-cookie')).toContain('__Host-td_session=');

    const denied = await fetchWorker(
      '/api/session',
      createEnv(undefined, createSessionNamespace([], 401)),
    );
    const body = await denied.text();
    expect(denied.status).toBe(500);
    expect(body).toContain('INTERNAL_ERROR');
    expect(body).not.toContain('sessionHash');
  });

  it('authorizes through a hash-only internal request and safely handles failures', async () => {
    const requests: unknown[] = [];
    await expect(
      authorizeSession(
        createSessionNamespace(requests),
        'internal-id',
        'A'.repeat(43),
        'B'.repeat(43),
        100,
      ),
    ).resolves.toBe(true);
    expect(Object.keys(requests[0] as Record<string, unknown>).sort()).toEqual([
      'csrfHash',
      'now',
      'sessionHash',
    ]);
    await expect(
      authorizeSession(
        createSessionNamespace([], 500),
        'internal-id',
        'A'.repeat(43),
        'B'.repeat(43),
      ),
    ).resolves.toBe(false);
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

  it('returns a Traditional Chinese JSON error for unknown API paths', async () => {
    const response = await fetchWorker('/api/missing');

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'NOT_FOUND', message: '找不到請求的 API 路徑。' },
    });
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

    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
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
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
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

import { describe, expect, it, vi } from 'vitest';

import worker, { type Env } from '../src/index.js';

const expectedHost = 'threads.example.test';

function createEnv(assetResponse = new Response('<app-root></app-root>', { status: 200 })): Env {
  return {
    EXPECTED_HOST: expectedHost,
    EXPECTED_ORIGIN: `https://${expectedHost}`,
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

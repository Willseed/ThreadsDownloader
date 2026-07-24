import { createApiError, type HealthResponse } from '@threads-downloader/contracts';
import { Hono } from 'hono';

import { createOpaqueId } from './security/cryptography.js';

export interface Env {
  readonly ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
  readonly EXPECTED_HOST: string;
  readonly EXPECTED_ORIGIN: string;
}

const securityHeaders = {
  'content-security-policy':
    "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), geolocation=(), microphone=()',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000',
  'x-content-type-options': 'nosniff',
} as const;

function requestId(): string {
  return createOpaqueId();
}

function applyResponsePolicy(response: Response): Response {
  for (const name of [...response.headers.keys()]) {
    if (name.startsWith('access-control-')) {
      response.headers.delete(name);
    }
  }

  for (const [name, value] of Object.entries(securityHeaders)) {
    response.headers.set(name, value);
  }

  return response;
}

function notFoundApi(id: string): Response {
  return Response.json(createApiError('NOT_FOUND', '找不到請求的 API 路徑。', id), { status: 404 });
}

function internalServerError(): Response {
  return Response.json(createApiError('INTERNAL_ERROR', '伺服器暫時無法處理請求。', requestId()), {
    status: 500,
  });
}

export const app = new Hono<{ Bindings: Env }>();

app.onError(() => internalServerError());

app.get('/api/health', (context) => {
  const response: HealthResponse = { status: 'ok', requestId: requestId() };
  return context.json(response, 200);
});

app.all('/api', () => notFoundApi(requestId()));
app.all('/api/*', () => notFoundApi(requestId()));
app.all('*', (context) => context.env.ASSETS.fetch(context.req.raw));

const worker = {
  async fetch(request: Request, env: Env, executionContext: ExecutionContext): Promise<Response> {
    const hostname = new URL(request.url).hostname;
    if (hostname !== env.EXPECTED_HOST) {
      return applyResponsePolicy(new Response('Not Found', { status: 404 }));
    }

    return applyResponsePolicy(await app.fetch(request, env, executionContext));
  },
};

export default worker;

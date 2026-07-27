import { createApiError, type HealthResponse } from '@threads-downloader/contracts';
import { Hono } from 'hono';

import { createOpaqueId } from './security/cryptography.js';
import type { DownloadSessionNamespace } from './security/download-session-client.js';
import type { SessionNamespace } from './security/session-client.js';
import {
  createBrowserSessionRenderedPagePort,
  type BrowserSessionCleanupScheduler,
} from './resolver/browser-session-renderer.js';
import { IpRateLimiter } from './ip-rate-limiter.js';
import { TurnstileReplay } from './turnstile-replay.js';
import {
  createResolvePublicMediaHandler,
  serializeResolveFailureEvent,
  type ResolvePublicMediaBindings,
} from './workflows/resolve-public-media.js';
import { createPublicDownloadApiHandler } from './workflows/public-download-api.js';
import { createSessionWorkflowHandler } from './workflows/session.js';

export {
  acquireSessionResolvePermit,
  authorizeSession,
  releaseSessionResolvePermit,
  SessionResolvePermitError,
} from './security/session-client.js';
export type {
  BrowserSessionIdentity,
  SessionNamespace,
  SessionResolvePermit,
} from './security/session-client.js';
export type { DownloadSessionNamespace } from './security/download-session-client.js';
export { DownloadSession } from './download-session.js';
export { SessionCoordinator } from './session-coordinator.js';

export interface Env {
  readonly ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
  readonly BROWSER?: BrowserRun;
  readonly DOWNLOAD_ENCRYPTION_KEY: string;
  readonly DOWNLOAD_SESSIONS: DownloadSessionNamespace;
  readonly EXPECTED_HOST: string;
  readonly EXPECTED_ORIGIN: string;
  readonly IP_RATE_LIMITS: DurableObjectNamespace<IpRateLimiter>;
  readonly RESOLVED_MEDIA_GRANT_KEY: string;
  readonly SESSION_SIGNING_KEY: string;
  readonly SESSIONS: SessionNamespace;
  readonly TURNSTILE_REPLAYS: DurableObjectNamespace<TurnstileReplay>;
  readonly TURNSTILE_SECRET: string;
  readonly TURNSTILE_SITE_KEY: string;
}

const securityHeaders = {
  'content-security-policy': [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self' https://challenges.cloudflare.com https://static.cloudflareinsights.com",
    "style-src 'self'",
    'frame-src https://challenges.cloudflare.com',
    "connect-src 'self'",
    "media-src 'self' https://cdninstagram.com https://*.cdninstagram.com https://*.fna.fbcdn.net",
  ].join('; '),
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), geolocation=(), microphone=()',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000',
  'x-content-type-options': 'nosniff',
} as const;

function requestId(): string {
  return createOpaqueId();
}

const resolvePublicMedia = createResolvePublicMediaHandler({
  fetcher: fetch,
  now: Date.now,
  reportFailure(event) {
    console.error(serializeResolveFailureEvent(event));
  },
  requestId,
});

function resolveBindings(
  env: Env,
  cleanupScheduler: BrowserSessionCleanupScheduler,
): ResolvePublicMediaBindings {
  return {
    EXPECTED_HOST: env.EXPECTED_HOST,
    EXPECTED_ORIGIN: env.EXPECTED_ORIGIN,
    IP_RATE_LIMITS: env.IP_RATE_LIMITS,
    SESSION_SIGNING_KEY: env.SESSION_SIGNING_KEY,
    SESSIONS: env.SESSIONS,
    TURNSTILE_REPLAYS: env.TURNSTILE_REPLAYS,
    TURNSTILE_SECRET: env.TURNSTILE_SECRET,
    ...(env.BROWSER === undefined
      ? {}
      : {
          BROWSER: createBrowserSessionRenderedPagePort(env.BROWSER, undefined, cleanupScheduler),
        }),
  };
}

const publicDownloadApi = createPublicDownloadApiHandler({
  fetcher: (request) => fetch(request),
  now: Date.now,
  requestId,
});

const sessionWorkflow = createSessionWorkflowHandler({
  now: Date.now,
  requestId,
});

function applyResponsePolicy(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const name of response.headers.keys()) {
    if (name.startsWith('access-control-')) {
      headers.delete(name);
    }
  }

  for (const [name, value] of Object.entries(securityHeaders)) {
    headers.set(name, value);
  }

  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function notFoundApi(id: string): Response {
  return Response.json(createApiError('NOT_FOUND', '找不到請求的 API 路徑。', id), {
    status: 404,
    headers: { 'cache-control': 'no-store' },
  });
}

function internalServerError(): Response {
  return Response.json(createApiError('INTERNAL_ERROR', '伺服器暫時無法處理請求。', requestId()), {
    status: 500,
    headers: { 'cache-control': 'no-store' },
  });
}

export const app = new Hono<{ Bindings: Env }>();

app.onError(() => internalServerError());

app.get('/api/health', (context) => {
  const response: HealthResponse = { status: 'ok', requestId: requestId() };
  return context.json(response, 200, { 'cache-control': 'no-store' });
});

app.get('/api/session', (context) => sessionWorkflow(context.req.raw, context.env));

app.post('/api/resolve', (context) => {
  const cleanupScheduler: BrowserSessionCleanupScheduler = (cleanup) => {
    context.executionCtx.waitUntil(cleanup);
  };
  return resolvePublicMedia(context.req.raw, resolveBindings(context.env, cleanupScheduler));
});

app.post('/api/download-sessions', (context) => publicDownloadApi(context.req.raw, context.env));

app.post('/api/preview-sessions', (context) => publicDownloadApi(context.req.raw, context.env));

app.get('/api/preview/:capability', (context) => publicDownloadApi(context.req.raw, context.env));

app.get('/api/download/:downloadId', (context) => publicDownloadApi(context.req.raw, context.env));

app.get('/api/download-status/:downloadId', (context) =>
  publicDownloadApi(context.req.raw, context.env),
);

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
export { IpRateLimiter, TurnstileReplay };

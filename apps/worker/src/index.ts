import {
  createApiError,
  type HealthResponse,
  type SessionResponse,
} from '@threads-downloader/contracts';
import { Hono } from 'hono';

import {
  BrowserSessionError,
  createBrowserSession,
  resumeBrowserSession,
  rotateCsrfToken,
} from './security/browser-session.js';
import {
  createOpaqueId,
  createOpaqueValueSigner,
  importSigningKey,
} from './security/cryptography.js';
import type { DownloadSessionNamespace } from './security/download-session-client.js';
import {
  createSession,
  resumeSession,
  SessionProvisioningError,
  type SessionNamespace,
} from './security/session-client.js';
import {
  reserveSessionIssuance,
  SessionIssuanceError,
  type SessionIssuanceReservation,
} from './security/session-issuance.js';
import { IpRateLimiter } from './ip-rate-limiter.js';
import { TurnstileReplay } from './turnstile-replay.js';
import { createResolvePublicMediaHandler } from './workflows/resolve-public-media.js';
import { createPublicDownloadApiHandler } from './workflows/public-download-api.js';

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
  requestId,
});

const publicDownloadApi = createPublicDownloadApiHandler({
  fetcher: (request) => fetch(request),
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

async function sessionResponse(request: Request, env: Env): Promise<Response> {
  let signingKey: CryptoKey;
  try {
    signingKey = await importSigningKey(env.SESSION_SIGNING_KEY);
  } catch {
    return sessionUnavailable();
  }
  const signer = createOpaqueValueSigner(signingKey);
  const now = Date.now();
  try {
    const resumed = await resumeBrowserSession(request.headers.get('cookie'), signer);
    const csrf = await rotateCsrfToken();
    const result = await resumeSession(env.SESSIONS, resumed.rawId, {
      sessionHash: resumed.sessionHash,
      csrfHash: csrf.csrfHash,
    });
    if (result.resumed) {
      return sessionSuccess(csrf.csrfToken, result.expiresAt, env.TURNSTILE_SITE_KEY, null);
    }
  } catch (error: unknown) {
    if (error instanceof BrowserSessionError && error.code === 'SESSION_COOKIE_INVALID') {
      return createReplacementSession(request, env, signingKey, signer, now);
    }
    return sessionUnavailable();
  }
  return createReplacementSession(request, env, signingKey, signer, now);
}

function sessionSuccess(
  csrfToken: string,
  expiresAt: number,
  turnstileSiteKey: string,
  setCookie: string | null,
): Response {
  const body: SessionResponse = {
    csrfToken,
    expiresAt: new Date(expiresAt).toISOString(),
    turnstileSiteKey,
  };
  const headers = new Headers({ 'cache-control': 'no-store' });
  if (setCookie !== null) {
    headers.set('set-cookie', setCookie);
  }
  return Response.json(body, { headers });
}

function sessionUnavailable(): Response {
  return Response.json(
    createApiError('SESSION_UNAVAILABLE', '工作階段暫時無法使用，請稍後再試。', requestId()),
    { status: 503, headers: { 'cache-control': 'no-store' } },
  );
}

function sessionRateLimited(retryAt: number, now: number): Response {
  const retryAfter = Math.max(1, Math.ceil((retryAt - now) / 1000));
  return Response.json(createApiError('RATE_LIMITED', '操作過於頻繁，請稍後再試。', requestId()), {
    status: 429,
    headers: { 'cache-control': 'no-store', 'retry-after': String(retryAfter) },
  });
}

async function createReplacementSession(
  request: Request,
  env: Env,
  signingKey: CryptoKey,
  signer: ReturnType<typeof createOpaqueValueSigner>,
  now: number,
): Promise<Response> {
  let reservation: SessionIssuanceReservation;
  try {
    reservation = await reserveSessionIssuance({
      headers: request.headers,
      ipRateLimits: env.IP_RATE_LIMITS,
      signingKey,
      now,
    });
  } catch (error: unknown) {
    return error instanceof SessionIssuanceError &&
      error.code === 'SESSION_ISSUANCE_RATE_LIMITED' &&
      error.retryAt !== undefined
      ? sessionRateLimited(error.retryAt, now)
      : sessionUnavailable();
  }

  let created;
  try {
    created = await createBrowserSession(signer, now);
  } catch {
    await reservation.release(now);
    return sessionUnavailable();
  }

  let expiresAt: number;
  try {
    expiresAt = await createSession(env.SESSIONS, created.rawId, {
      sessionHash: created.sessionHash,
      csrfHash: created.csrfHash,
      issuedAt: created.issuedAt,
      expiresAt: created.expiresAt,
    });
  } catch (error: unknown) {
    if (error instanceof SessionProvisioningError && error.code === 'SESSION_CREATE_CONFLICT') {
      await reservation.release(now);
    }
    return sessionUnavailable();
  }
  if (expiresAt !== created.expiresAt) {
    return sessionUnavailable();
  }
  try {
    await reservation.commit(now);
  } catch {
    return sessionUnavailable();
  }
  return sessionSuccess(created.csrfToken, expiresAt, env.TURNSTILE_SITE_KEY, created.setCookie);
}

export const app = new Hono<{ Bindings: Env }>();

app.onError(() => internalServerError());

app.get('/api/health', (context) => {
  const response: HealthResponse = { status: 'ok', requestId: requestId() };
  return context.json(response, 200, { 'cache-control': 'no-store' });
});

app.get('/api/session', (context) => sessionResponse(context.req.raw, context.env));

app.post('/api/resolve', (context) => resolvePublicMedia(context.req.raw, context.env));

app.post('/api/download-sessions', (context) => publicDownloadApi(context.req.raw, context.env));

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

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
  SESSION_TTL_SECONDS,
} from './security/browser-session.js';
import {
  createOpaqueId,
  createOpaqueValueSigner,
  importSigningKey,
} from './security/cryptography.js';
import { SessionCoordinator } from './session-coordinator.js';

interface SessionStub {
  fetch(request: Request): Promise<Response>;
}

export interface SessionNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): SessionStub;
}

export interface Env {
  readonly ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
  readonly EXPECTED_HOST: string;
  readonly EXPECTED_ORIGIN: string;
  readonly SESSION_SIGNING_KEY: string;
  readonly SESSIONS: SessionNamespace;
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function bootstrapSession(
  namespace: SessionNamespace,
  rawId: string,
  input: {
    readonly sessionHash: string;
    readonly csrfHash: string;
    readonly issuedAt: number;
    readonly expiresAt: number;
  },
): Promise<number> {
  const stub = namespace.get(namespace.idFromName(rawId));
  const response = await stub.fetch(
    new Request('https://session.internal/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
  );
  if (response.status !== 200) {
    throw new BrowserSessionError('SESSION_OPERATION_FAILED');
  }
  const body: unknown = await response.json();
  if (
    !isPlainObject(body) ||
    Object.keys(body).length !== 2 ||
    body['ok'] !== true ||
    typeof body['expiresAt'] !== 'number' ||
    !Number.isSafeInteger(body['expiresAt']) ||
    body['expiresAt'] < 0 ||
    body['expiresAt'] > 8_640_000_000_000_000
  ) {
    throw new BrowserSessionError('SESSION_OPERATION_FAILED');
  }
  return body['expiresAt'];
}

export async function authorizeSession(
  namespace: SessionNamespace,
  rawId: string,
  sessionHash: string,
  csrfHash: string,
  now = Date.now(),
): Promise<boolean> {
  try {
    const stub = namespace.get(namespace.idFromName(rawId));
    const response = await stub.fetch(
      new Request('https://session.internal/authorize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionHash, csrfHash, now }),
      }),
    );
    if (response.status !== 200) {
      return false;
    }
    const body: unknown = await response.json();
    return isPlainObject(body) && Object.keys(body).length === 1 && body['ok'] === true;
  } catch {
    return false;
  }
}

async function sessionResponse(request: Request, env: Env): Promise<Response> {
  const signingKey = await importSigningKey(env.SESSION_SIGNING_KEY);
  const signer = createOpaqueValueSigner(signingKey);
  const now = Date.now();
  let rawId: string;
  let sessionHash: string;
  let csrfToken: string;
  let csrfHash: string;
  let setCookie: string | null = null;
  try {
    const resumed = await resumeBrowserSession(request.headers.get('cookie'), signer);
    const csrf = await rotateCsrfToken();
    rawId = resumed.rawId;
    sessionHash = resumed.sessionHash;
    csrfToken = csrf.csrfToken;
    csrfHash = csrf.csrfHash;
  } catch (error: unknown) {
    if (!(error instanceof BrowserSessionError) || error.code !== 'SESSION_COOKIE_INVALID') {
      throw error;
    }
    const created = await createBrowserSession(signer, now);
    rawId = created.rawId;
    sessionHash = created.sessionHash;
    csrfToken = created.csrfToken;
    csrfHash = created.csrfHash;
    setCookie = created.setCookie;
  }

  const expiresAt = await bootstrapSession(env.SESSIONS, rawId, {
    sessionHash,
    csrfHash,
    issuedAt: now,
    expiresAt: now + SESSION_TTL_SECONDS * 1000,
  });
  const body: SessionResponse = { csrfToken, expiresAt: new Date(expiresAt).toISOString() };
  const headers = new Headers({ 'cache-control': 'no-store' });
  if (setCookie !== null) {
    headers.set('set-cookie', setCookie);
  }
  return Response.json(body, { headers });
}

export const app = new Hono<{ Bindings: Env }>();

app.onError(() => internalServerError());

app.get('/api/health', (context) => {
  const response: HealthResponse = { status: 'ok', requestId: requestId() };
  return context.json(response, 200);
});

app.get('/api/session', (context) => sessionResponse(context.req.raw, context.env));

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
export { SessionCoordinator };

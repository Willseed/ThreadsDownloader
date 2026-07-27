import { createApiError, type SessionResponse } from '@threads-downloader/contracts';

import {
  BrowserSessionError,
  createBrowserSession,
  resumeBrowserSession,
  rotateCsrfToken,
} from '../security/browser-session.js';
import { createOpaqueValueSigner, importSigningKey } from '../security/cryptography.js';
import {
  createSession,
  resumeSession,
  SessionProvisioningError,
  type SessionNamespace,
} from '../security/session-client.js';
import {
  reserveSessionIssuance,
  SessionIssuanceError,
  type SessionIssuanceRateLimitNamespace,
  type SessionIssuanceReservation,
} from '../security/session-issuance.js';

export interface SessionWorkflowBindings {
  readonly IP_RATE_LIMITS: SessionIssuanceRateLimitNamespace;
  readonly SESSION_SIGNING_KEY: string;
  readonly SESSIONS: SessionNamespace;
  readonly TURNSTILE_SITE_KEY: string;
}

export interface SessionWorkflowRuntime {
  readonly now: () => number;
  readonly requestId: () => string;
}

export type SessionWorkflowHandler = (
  request: Request,
  bindings: SessionWorkflowBindings,
) => Promise<Response>;

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

function sessionUnavailable(runtime: SessionWorkflowRuntime): Response {
  return Response.json(
    createApiError(
      'SESSION_UNAVAILABLE',
      '工作階段暫時無法使用，請稍後再試。',
      runtime.requestId(),
    ),
    { status: 503, headers: { 'cache-control': 'no-store' } },
  );
}

function sessionRateLimited(
  retryAt: number,
  now: number,
  runtime: SessionWorkflowRuntime,
): Response {
  const retryAfter = Math.max(1, Math.ceil((retryAt - now) / 1000));
  return Response.json(
    createApiError('RATE_LIMITED', '操作過於頻繁，請稍後再試。', runtime.requestId()),
    {
      status: 429,
      headers: { 'cache-control': 'no-store', 'retry-after': String(retryAfter) },
    },
  );
}

async function createReplacementSession(
  request: Request,
  bindings: SessionWorkflowBindings,
  signingKey: CryptoKey,
  signer: ReturnType<typeof createOpaqueValueSigner>,
  now: number,
  runtime: SessionWorkflowRuntime,
): Promise<Response> {
  let reservation: SessionIssuanceReservation;
  try {
    reservation = await reserveSessionIssuance({
      headers: request.headers,
      ipRateLimits: bindings.IP_RATE_LIMITS,
      signingKey,
      now,
    });
  } catch (error: unknown) {
    return error instanceof SessionIssuanceError &&
      error.code === 'SESSION_ISSUANCE_RATE_LIMITED' &&
      error.retryAt !== undefined
      ? sessionRateLimited(error.retryAt, now, runtime)
      : sessionUnavailable(runtime);
  }

  let created;
  try {
    created = await createBrowserSession(signer, now);
  } catch {
    await reservation.release(now);
    return sessionUnavailable(runtime);
  }

  let expiresAt: number;
  try {
    expiresAt = await createSession(bindings.SESSIONS, created.rawId, {
      sessionHash: created.sessionHash,
      csrfHash: created.csrfHash,
      issuedAt: created.issuedAt,
      expiresAt: created.expiresAt,
    });
  } catch (error: unknown) {
    if (error instanceof SessionProvisioningError && error.code === 'SESSION_CREATE_CONFLICT') {
      await reservation.release(now);
    }
    return sessionUnavailable(runtime);
  }
  if (expiresAt !== created.expiresAt) {
    return sessionUnavailable(runtime);
  }
  try {
    await reservation.commit(now);
  } catch {
    return sessionUnavailable(runtime);
  }
  return sessionSuccess(
    created.csrfToken,
    expiresAt,
    bindings.TURNSTILE_SITE_KEY,
    created.setCookie,
  );
}

export function createSessionWorkflowHandler(
  runtime: SessionWorkflowRuntime,
): SessionWorkflowHandler {
  return async (request, bindings): Promise<Response> => {
    let signingKey: CryptoKey;
    try {
      signingKey = await importSigningKey(bindings.SESSION_SIGNING_KEY);
    } catch {
      return sessionUnavailable(runtime);
    }
    const signer = createOpaqueValueSigner(signingKey);
    const now = runtime.now();
    try {
      const resumed = await resumeBrowserSession(request.headers.get('cookie'), signer);
      const csrf = await rotateCsrfToken();
      const result = await resumeSession(bindings.SESSIONS, resumed.rawId, {
        sessionHash: resumed.sessionHash,
        csrfHash: csrf.csrfHash,
      });
      if (result.resumed) {
        return sessionSuccess(csrf.csrfToken, result.expiresAt, bindings.TURNSTILE_SITE_KEY, null);
      }
    } catch (error: unknown) {
      if (error instanceof BrowserSessionError && error.code === 'SESSION_COOKIE_INVALID') {
        return createReplacementSession(request, bindings, signingKey, signer, now, runtime);
      }
      return sessionUnavailable(runtime);
    }
    return createReplacementSession(request, bindings, signingKey, signer, now, runtime);
  };
}

import { BrowserSessionError } from './browser-session.js';
import { createOpaqueId } from './cryptography.js';

interface SessionStub {
  fetch(request: Request): Promise<Response>;
}

export interface SessionNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): SessionStub;
}

export interface BrowserSessionIdentity {
  readonly rawId: string;
  readonly sessionHash: string;
}

export interface SessionResolvePermit {
  readonly permitId: string;
  readonly expiresAt: number;
}

export type SessionResolvePermitErrorCode =
  'RESOLVE_PERMIT_DENIED' | 'RESOLVE_PERMIT_UNAVAILABLE' | 'SESSION_INVALID';

export class SessionResolvePermitError extends Error {
  constructor(readonly code: SessionResolvePermitErrorCode) {
    super(code);
    this.name = 'SessionResolvePermitError';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function bootstrapSession(
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

export async function acquireSessionResolvePermit(
  namespace: SessionNamespace,
  identity: BrowserSessionIdentity,
  csrfHash: string,
  now = Date.now(),
): Promise<SessionResolvePermit> {
  const permitId = createOpaqueId();
  let response: Response;
  try {
    const stub = namespace.get(namespace.idFromName(identity.rawId));
    response = await stub.fetch(
      new Request('https://session.internal/resolve-permits/acquire', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionHash: identity.sessionHash,
          csrfHash,
          now,
          permitId,
        }),
      }),
    );
  } catch {
    throw new SessionResolvePermitError('RESOLVE_PERMIT_UNAVAILABLE');
  }
  if (response.status === 401) {
    throw new SessionResolvePermitError('SESSION_INVALID');
  }
  if (response.status === 429) {
    throw new SessionResolvePermitError('RESOLVE_PERMIT_DENIED');
  }
  if (response.status !== 201) {
    throw new SessionResolvePermitError('RESOLVE_PERMIT_UNAVAILABLE');
  }
  try {
    const body: unknown = await response.json();
    if (
      !isPlainObject(body) ||
      Object.keys(body).length !== 2 ||
      body['ok'] !== true ||
      typeof body['expiresAt'] !== 'number' ||
      !Number.isSafeInteger(body['expiresAt']) ||
      body['expiresAt'] <= now
    ) {
      throw new SessionResolvePermitError('RESOLVE_PERMIT_UNAVAILABLE');
    }
    return { permitId, expiresAt: body['expiresAt'] };
  } catch (error: unknown) {
    if (error instanceof SessionResolvePermitError) {
      throw error;
    }
    throw new SessionResolvePermitError('RESOLVE_PERMIT_UNAVAILABLE');
  }
}

export async function releaseSessionResolvePermit(
  namespace: SessionNamespace,
  identity: BrowserSessionIdentity,
  permitId: string,
  now = Date.now(),
): Promise<boolean> {
  try {
    const stub = namespace.get(namespace.idFromName(identity.rawId));
    const response = await stub.fetch(
      new Request('https://session.internal/resolve-permits/release', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionHash: identity.sessionHash, permitId, now }),
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

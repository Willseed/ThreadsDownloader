import {
  createSessionCoordinatorRequest,
  SESSION_COORDINATOR_ROUTES,
} from '../session-coordinator-protocol.js';
import { createOpaqueId } from './cryptography.js';

export {
  claimResolvedMediaCandidate,
  ResolveVaultError,
  settleResolvedMediaClaim,
  storeResolvedMediaBatch,
} from './resolve-vault.js';
export type {
  ClaimResolvedMediaCandidateInput,
  ResolvedMediaClaim,
  ResolveVaultErrorCode,
  SafeResolvedMediaCandidate,
  SettleResolvedMediaClaimInput,
  StoredResolvedMediaBatch,
  StoreResolvedMediaBatchInput,
} from './resolve-vault.js';

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

export type SessionProvisioningErrorCode = 'SESSION_CREATE_CONFLICT' | 'SESSION_UNAVAILABLE';

export class SessionProvisioningError extends Error {
  constructor(readonly code: SessionProvisioningErrorCode) {
    super(code);
    this.name = 'SessionProvisioningError';
  }
}

export type ResumeSessionResult =
  { readonly resumed: true; readonly expiresAt: number } | { readonly resumed: false };

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

function unavailable(): SessionProvisioningError {
  return new SessionProvisioningError('SESSION_UNAVAILABLE');
}

async function decodeSessionExpiry(response: Response): Promise<number> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw unavailable();
  }
  if (
    !isPlainObject(body) ||
    Object.keys(body).length !== 2 ||
    body['ok'] !== true ||
    typeof body['expiresAt'] !== 'number' ||
    !Number.isSafeInteger(body['expiresAt']) ||
    body['expiresAt'] < 0 ||
    body['expiresAt'] > 8_640_000_000_000_000
  ) {
    throw unavailable();
  }
  return body['expiresAt'];
}

export async function createSession(
  namespace: SessionNamespace,
  rawId: string,
  input: {
    readonly sessionHash: string;
    readonly csrfHash: string;
    readonly issuedAt: number;
    readonly expiresAt: number;
  },
): Promise<number> {
  let response: Response;
  try {
    const stub = namespace.get(namespace.idFromName(rawId));
    response = await stub.fetch(
      createSessionCoordinatorRequest(SESSION_COORDINATOR_ROUTES.session.create, input),
    );
  } catch {
    throw unavailable();
  }
  if (response.status === 409) {
    throw new SessionProvisioningError('SESSION_CREATE_CONFLICT');
  }
  if (response.status !== 200) {
    throw unavailable();
  }
  return decodeSessionExpiry(response);
}

export async function resumeSession(
  namespace: SessionNamespace,
  rawId: string,
  input: { readonly sessionHash: string; readonly csrfHash: string },
): Promise<ResumeSessionResult> {
  let response: Response;
  try {
    const stub = namespace.get(namespace.idFromName(rawId));
    response = await stub.fetch(
      createSessionCoordinatorRequest(SESSION_COORDINATOR_ROUTES.session.resume, input),
    );
  } catch {
    throw unavailable();
  }
  if (response.status === 410) {
    return { resumed: false };
  }
  if (response.status !== 200) {
    throw unavailable();
  }
  return { resumed: true, expiresAt: await decodeSessionExpiry(response) };
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
      createSessionCoordinatorRequest(SESSION_COORDINATOR_ROUTES.session.authorize, {
        sessionHash,
        csrfHash,
        now,
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
      createSessionCoordinatorRequest(SESSION_COORDINATOR_ROUTES.resolvePermits.acquire, {
        sessionHash: identity.sessionHash,
        csrfHash,
        now,
        permitId,
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
      createSessionCoordinatorRequest(SESSION_COORDINATOR_ROUTES.resolvePermits.release, {
        sessionHash: identity.sessionHash,
        permitId,
        now,
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

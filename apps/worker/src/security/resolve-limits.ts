import {
  acquireSessionResolvePermit,
  releaseSessionResolvePermit,
  SessionResolvePermitError,
  type BrowserSessionIdentity,
  type SessionNamespace,
} from './session-client.js';
import { createKeyedIdentifierHasher } from './cryptography.js';
import { ClientIpError, hashClientIp } from './client-ip.js';
import type { HeaderSource } from './browser-session.js';

export interface IpRateLimitStub {
  fetch(request: Request): Promise<Response>;
}

export interface IpRateLimitNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): IpRateLimitStub;
}

export type ResolveLimitsErrorCode =
  | 'IP_RATE_LIMITED'
  | 'RESOLVE_CLIENT_IP_INVALID'
  | 'RESOLVE_LIMITS_UNAVAILABLE'
  | 'SESSION_INVALID'
  | 'SESSION_RATE_LIMITED';

export class ResolveLimitsError extends Error {
  constructor(readonly code: ResolveLimitsErrorCode) {
    super(code);
    this.name = 'ResolveLimitsError';
  }
}

export interface AcquireResolveLimitsInput {
  readonly sessions: SessionNamespace;
  readonly ipRateLimits: IpRateLimitNamespace;
  readonly signingKey: CryptoKey;
  readonly identity: BrowserSessionIdentity;
  readonly csrfHash: string;
  readonly headers: HeaderSource;
  readonly now: number;
}

export interface ResolveLimitsLease {
  readonly permitId: string;
  readonly expiresAt: number;
  release(): Promise<void>;
}

function unavailable(): ResolveLimitsError {
  return new ResolveLimitsError('RESOLVE_LIMITS_UNAVAILABLE');
}

async function acquireIpPermit(
  namespace: IpRateLimitNamespace,
  ipHash: string,
  permitId: string,
  now: number,
): Promise<number> {
  let response: Response;
  try {
    const stub = namespace.get(namespace.idFromName(ipHash));
    response = await stub.fetch(
      new Request('https://ip-rate-limit.internal/acquire', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ipHash, permitId, now }),
      }),
    );
  } catch {
    throw unavailable();
  }
  if (response.status === 429) {
    throw new ResolveLimitsError('IP_RATE_LIMITED');
  }
  if (response.status !== 201) {
    throw unavailable();
  }
  try {
    const body: unknown = await response.json();
    if (
      typeof body !== 'object' ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).length !== 2 ||
      (body as Record<string, unknown>)['ok'] !== true ||
      typeof (body as Record<string, unknown>)['expiresAt'] !== 'number' ||
      !Number.isSafeInteger((body as Record<string, unknown>)['expiresAt']) ||
      ((body as Record<string, unknown>)['expiresAt'] as number) <= now
    ) {
      throw unavailable();
    }
    return (body as Record<string, unknown>)['expiresAt'] as number;
  } catch (error: unknown) {
    if (error instanceof ResolveLimitsError) {
      throw error;
    }
    throw unavailable();
  }
}

async function releaseIpPermit(
  namespace: IpRateLimitNamespace,
  ipHash: string,
  permitId: string,
  now: number,
): Promise<boolean> {
  try {
    const stub = namespace.get(namespace.idFromName(ipHash));
    const response = await stub.fetch(
      new Request('https://ip-rate-limit.internal/release', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ipHash, permitId, now }),
      }),
    );
    return response.status === 200;
  } catch {
    return false;
  }
}

function sessionError(error: unknown): ResolveLimitsError {
  if (error instanceof SessionResolvePermitError) {
    if (error.code === 'SESSION_INVALID') {
      return new ResolveLimitsError('SESSION_INVALID');
    }
    if (error.code === 'RESOLVE_PERMIT_DENIED') {
      return new ResolveLimitsError('SESSION_RATE_LIMITED');
    }
  }
  return unavailable();
}

export async function acquireResolveLimits(
  input: AcquireResolveLimitsInput,
): Promise<ResolveLimitsLease> {
  let sessionPermit;
  try {
    sessionPermit = await acquireSessionResolvePermit(
      input.sessions,
      input.identity,
      input.csrfHash,
      input.now,
    );
  } catch (error: unknown) {
    throw sessionError(error);
  }

  let ipHash: string;
  let ipExpiresAt: number;
  try {
    ipHash = await hashClientIp(input.headers, createKeyedIdentifierHasher(input.signingKey));
    ipExpiresAt = await acquireIpPermit(
      input.ipRateLimits,
      ipHash,
      sessionPermit.permitId,
      input.now,
    );
  } catch (error: unknown) {
    await releaseSessionResolvePermit(
      input.sessions,
      input.identity,
      sessionPermit.permitId,
      input.now,
    );
    if (error instanceof ResolveLimitsError) {
      throw error;
    }
    if (error instanceof ClientIpError && error.code === 'CLIENT_IP_INVALID') {
      throw new ResolveLimitsError('RESOLVE_CLIENT_IP_INVALID');
    }
    throw unavailable();
  }

  let released = false;
  return {
    permitId: sessionPermit.permitId,
    expiresAt: Math.min(sessionPermit.expiresAt, ipExpiresAt),
    async release(): Promise<void> {
      if (released) {
        return;
      }
      released = true;
      await Promise.all([
        releaseSessionResolvePermit(
          input.sessions,
          input.identity,
          sessionPermit.permitId,
          input.now,
        ),
        releaseIpPermit(input.ipRateLimits, ipHash, sessionPermit.permitId, input.now),
      ]).catch(() => undefined);
    },
  };
}

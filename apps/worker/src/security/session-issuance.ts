import type { HeaderSource } from './browser-session.js';
import { hashClientIp } from './client-ip.js';
import { createKeyedIdentifierHasher, createOpaqueId } from './cryptography.js';
import { SESSION_ISSUANCE_RESERVATION_MS } from './session-issuance-rate-limit.js';

interface SessionIssuanceRateLimitStub {
  fetch(request: Request): Promise<Response>;
}

export interface SessionIssuanceRateLimitNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): SessionIssuanceRateLimitStub;
}

export type SessionIssuanceErrorCode =
  'SESSION_ISSUANCE_RATE_LIMITED' | 'SESSION_ISSUANCE_UNAVAILABLE';

export class SessionIssuanceError extends Error {
  constructor(
    readonly code: SessionIssuanceErrorCode,
    readonly retryAt?: number,
  ) {
    super(code);
    this.name = 'SessionIssuanceError';
  }
}

export interface SessionIssuanceReservation {
  readonly expiresAt: number;
  commit(now: number): Promise<void>;
  release(now: number): Promise<boolean>;
}

export interface ReserveSessionIssuanceInput {
  readonly headers: HeaderSource;
  readonly ipRateLimits: SessionIssuanceRateLimitNamespace;
  readonly signingKey: CryptoKey;
  readonly now: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = [...keys].sort((left, right) => left.localeCompare(right, 'en'));
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right, 'en'));
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function unavailable(): SessionIssuanceError {
  return new SessionIssuanceError('SESSION_ISSUANCE_UNAVAILABLE');
}

async function mutateReservation(
  namespace: SessionIssuanceRateLimitNamespace,
  ipHash: string,
  reservationId: string,
  operation: 'commit' | 'release',
  now: number,
): Promise<boolean> {
  try {
    const stub = namespace.get(namespace.idFromName(ipHash));
    const response = await stub.fetch(
      new Request(`https://ip-rate-limit.internal/session-issuance/${operation}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ipHash, reservationId, now }),
      }),
    );
    if (response.status !== 200) {
      return false;
    }
    const body: unknown = await response.json();
    return isPlainObject(body) && hasExactKeys(body, ['ok']) && body['ok'] === true;
  } catch {
    return false;
  }
}

export async function reserveSessionIssuance(
  input: ReserveSessionIssuanceInput,
): Promise<SessionIssuanceReservation> {
  let ipHash: string;
  try {
    ipHash = await hashClientIp(input.headers, createKeyedIdentifierHasher(input.signingKey));
  } catch {
    throw unavailable();
  }

  const reservationId = createOpaqueId();
  let response: Response;
  try {
    const stub = input.ipRateLimits.get(input.ipRateLimits.idFromName(ipHash));
    response = await stub.fetch(
      new Request('https://ip-rate-limit.internal/session-issuance/reserve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ipHash, reservationId, now: input.now }),
      }),
    );
  } catch {
    throw unavailable();
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw unavailable();
  }
  if (response.status === 429) {
    if (
      !isPlainObject(body) ||
      !hasExactKeys(body, ['ok', 'retryAt']) ||
      body['ok'] !== false ||
      typeof body['retryAt'] !== 'number' ||
      !Number.isSafeInteger(body['retryAt']) ||
      body['retryAt'] <= input.now
    ) {
      throw unavailable();
    }
    throw new SessionIssuanceError('SESSION_ISSUANCE_RATE_LIMITED', body['retryAt']);
  }
  const expectedExpiresAt = input.now + SESSION_ISSUANCE_RESERVATION_MS;
  if (
    response.status !== 201 ||
    !isPlainObject(body) ||
    !hasExactKeys(body, ['expiresAt', 'ok', 'reservationId']) ||
    body['ok'] !== true ||
    body['reservationId'] !== reservationId ||
    body['expiresAt'] !== expectedExpiresAt
  ) {
    throw unavailable();
  }

  return {
    expiresAt: expectedExpiresAt,
    async commit(now: number): Promise<void> {
      if (!(await mutateReservation(input.ipRateLimits, ipHash, reservationId, 'commit', now))) {
        throw unavailable();
      }
    },
    release(now: number): Promise<boolean> {
      return mutateReservation(input.ipRateLimits, ipHash, reservationId, 'release', now);
    },
  };
}

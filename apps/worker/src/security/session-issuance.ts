import { decodeExactRecord } from '@threads-downloader/contracts/strict-json';

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
    const record = decodeExactRecord(body, ['ok']);
    return record !== null && record['ok'] === true;
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
    const record = decodeExactRecord(body, ['ok', 'retryAt']);
    if (
      record === null ||
      record['ok'] !== false ||
      typeof record['retryAt'] !== 'number' ||
      !Number.isSafeInteger(record['retryAt']) ||
      record['retryAt'] <= input.now
    ) {
      throw unavailable();
    }
    throw new SessionIssuanceError('SESSION_ISSUANCE_RATE_LIMITED', record['retryAt']);
  }
  const expectedExpiresAt = input.now + SESSION_ISSUANCE_RESERVATION_MS;
  const record = decodeExactRecord(body, ['expiresAt', 'ok', 'reservationId']);
  if (
    response.status !== 201 ||
    record === null ||
    record['ok'] !== true ||
    record['reservationId'] !== reservationId ||
    record['expiresAt'] !== expectedExpiresAt
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

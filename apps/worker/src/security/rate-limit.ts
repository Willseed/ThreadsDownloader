import { decodeBase64Url } from '../utils/base64url.js';

export const RESOLVE_WINDOW_MS = 60_000;
export const MAX_RESOLVE_ATTEMPTS = 5;
export const MAX_CONCURRENT_RESOLVES = 1;
export const RESOLVE_PERMIT_LEASE_MS = 30_000;

export interface ResolvePermit {
  readonly id: string;
  readonly expiresAt: number;
}

export interface ResolveRateLimitState {
  readonly events: readonly number[];
  readonly permits: readonly ResolvePermit[];
}

export type ResolveRateLimitErrorCode =
  'RESOLVE_CONCURRENT_LIMIT' | 'RESOLVE_RATE_INVALID' | 'RESOLVE_WINDOW_LIMIT';

export class ResolveRateLimitError extends Error {
  constructor(readonly code: ResolveRateLimitErrorCode) {
    super(code);
    this.name = 'ResolveRateLimitError';
  }
}

function fail(code: ResolveRateLimitErrorCode): never {
  throw new ResolveRateLimitError(code);
}

function validTime(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validPermitId(value: string): boolean {
  try {
    return decodeBase64Url(value).byteLength >= 16;
  } catch {
    return false;
  }
}

function validateState(state: ResolveRateLimitState): void {
  if (
    !state.events.every(validTime) ||
    !state.permits.every((permit) => validPermitId(permit.id) && validTime(permit.expiresAt))
  ) {
    fail('RESOLVE_RATE_INVALID');
  }
}

export function pruneResolveRateLimit(
  state: ResolveRateLimitState,
  now: number,
): ResolveRateLimitState {
  if (!validTime(now)) {
    return fail('RESOLVE_RATE_INVALID');
  }
  validateState(state);
  return {
    events: state.events.filter((timestamp) => timestamp > now - RESOLVE_WINDOW_MS),
    permits: state.permits
      .filter((permit) => permit.expiresAt > now)
      .map((permit) => ({ ...permit })),
  };
}

export function acquireResolvePermit(
  state: ResolveRateLimitState,
  now: number,
  permitId: string,
): ResolveRateLimitState {
  if (!validPermitId(permitId) || now > Number.MAX_SAFE_INTEGER - RESOLVE_PERMIT_LEASE_MS) {
    return fail('RESOLVE_RATE_INVALID');
  }
  const current = pruneResolveRateLimit(state, now);
  if (current.permits.length >= MAX_CONCURRENT_RESOLVES) {
    return fail('RESOLVE_CONCURRENT_LIMIT');
  }
  if (current.events.length >= MAX_RESOLVE_ATTEMPTS) {
    return fail('RESOLVE_WINDOW_LIMIT');
  }
  return {
    events: [...current.events, now],
    permits: [...current.permits, { id: permitId, expiresAt: now + RESOLVE_PERMIT_LEASE_MS }],
  };
}

export function releaseResolvePermit(
  state: ResolveRateLimitState,
  now: number,
  permitId: string,
): ResolveRateLimitState {
  if (!validPermitId(permitId)) {
    return fail('RESOLVE_RATE_INVALID');
  }
  const current = pruneResolveRateLimit(state, now);
  return {
    events: [...current.events],
    permits: current.permits.filter((permit) => permit.id !== permitId),
  };
}

export function nextResolvePermitDeadline(state: ResolveRateLimitState): number | null {
  validateState(state);
  return state.permits.reduce<number | null>(
    (earliest, permit) =>
      earliest === null ? permit.expiresAt : Math.min(earliest, permit.expiresAt),
    null,
  );
}

import { decodeBase64Url } from '../utils/base64url.js';

export const RESOLVE_WINDOW_MS = 60_000;
export const MAX_RESOLVE_ATTEMPTS = 5;
export const MAX_CONCURRENT_RESOLVES = 1;
export const RESOLVE_PERMIT_LEASE_MS = 30_000;
export const IP_RESOLVE_WINDOW_MS = 60_000;
export const MAX_IP_RESOLVE_ATTEMPTS = 20;
export const MAX_CONCURRENT_IP_RESOLVES = 3;
export const IP_RESOLVE_PERMIT_LEASE_MS = 30_000;

export interface RateLimitPolicy {
  readonly windowMs: number;
  readonly maxAttempts: number;
  readonly maxConcurrent: number;
  readonly leaseMs: number;
}

export const SESSION_RESOLVE_POLICY: RateLimitPolicy = {
  windowMs: RESOLVE_WINDOW_MS,
  maxAttempts: MAX_RESOLVE_ATTEMPTS,
  maxConcurrent: MAX_CONCURRENT_RESOLVES,
  leaseMs: RESOLVE_PERMIT_LEASE_MS,
};

export const IP_RESOLVE_POLICY: RateLimitPolicy = {
  windowMs: IP_RESOLVE_WINDOW_MS,
  maxAttempts: MAX_IP_RESOLVE_ATTEMPTS,
  maxConcurrent: MAX_CONCURRENT_IP_RESOLVES,
  leaseMs: IP_RESOLVE_PERMIT_LEASE_MS,
};

export interface ResolvePermit {
  readonly id: string;
  readonly expiresAt: number;
}

export interface ResolveRateLimitState {
  readonly events: readonly number[];
  readonly permits: readonly ResolvePermit[];
}

export type RateLimitState = ResolveRateLimitState;

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

function validatePolicy(policy: RateLimitPolicy): void {
  if (
    !Number.isSafeInteger(policy.windowMs) ||
    policy.windowMs <= 0 ||
    !Number.isSafeInteger(policy.maxAttempts) ||
    policy.maxAttempts <= 0 ||
    !Number.isSafeInteger(policy.maxConcurrent) ||
    policy.maxConcurrent <= 0 ||
    !Number.isSafeInteger(policy.leaseMs) ||
    policy.leaseMs <= 0
  ) {
    fail('RESOLVE_RATE_INVALID');
  }
}

export function pruneRateLimit(
  state: RateLimitState,
  now: number,
  policy: RateLimitPolicy,
): RateLimitState {
  if (!validTime(now)) {
    return fail('RESOLVE_RATE_INVALID');
  }
  validatePolicy(policy);
  validateState(state);
  return {
    events: state.events.filter((timestamp) => timestamp > now - policy.windowMs),
    permits: state.permits
      .filter((permit) => permit.expiresAt > now)
      .map((permit) => ({ ...permit })),
  };
}

export function acquireRateLimitPermit(
  state: RateLimitState,
  now: number,
  permitId: string,
  policy: RateLimitPolicy,
): RateLimitState {
  if (!validPermitId(permitId) || now > Number.MAX_SAFE_INTEGER - policy.leaseMs) {
    return fail('RESOLVE_RATE_INVALID');
  }
  const current = pruneRateLimit(state, now, policy);
  if (current.permits.length >= policy.maxConcurrent) {
    return fail('RESOLVE_CONCURRENT_LIMIT');
  }
  if (current.events.length >= policy.maxAttempts) {
    return fail('RESOLVE_WINDOW_LIMIT');
  }
  return {
    events: [...current.events, now],
    permits: [...current.permits, { id: permitId, expiresAt: now + policy.leaseMs }],
  };
}

export function releaseRateLimitPermit(
  state: RateLimitState,
  now: number,
  permitId: string,
  policy: RateLimitPolicy,
): RateLimitState {
  if (!validPermitId(permitId)) {
    return fail('RESOLVE_RATE_INVALID');
  }
  const current = pruneRateLimit(state, now, policy);
  return {
    events: [...current.events],
    permits: current.permits.filter((permit) => permit.id !== permitId),
  };
}

export function nextRateLimitDeadline(
  state: RateLimitState,
  policy: RateLimitPolicy,
): number | null {
  validatePolicy(policy);
  validateState(state);
  const deadlines = [
    ...state.permits.map((permit) => permit.expiresAt),
    ...state.events.map((timestamp) => timestamp + policy.windowMs),
  ];
  return deadlines.length === 0 ? null : Math.min(...deadlines);
}

export function pruneResolveRateLimit(
  state: ResolveRateLimitState,
  now: number,
): ResolveRateLimitState {
  return pruneRateLimit(state, now, SESSION_RESOLVE_POLICY);
}

export function acquireResolvePermit(
  state: ResolveRateLimitState,
  now: number,
  permitId: string,
): ResolveRateLimitState {
  return acquireRateLimitPermit(state, now, permitId, SESSION_RESOLVE_POLICY);
}

export function releaseResolvePermit(
  state: ResolveRateLimitState,
  now: number,
  permitId: string,
): ResolveRateLimitState {
  return releaseRateLimitPermit(state, now, permitId, SESSION_RESOLVE_POLICY);
}

export function nextResolvePermitDeadline(state: ResolveRateLimitState): number | null {
  validateState(state);
  return state.permits.reduce<number | null>(
    (earliest, permit) =>
      earliest === null ? permit.expiresAt : Math.min(earliest, permit.expiresAt),
    null,
  );
}

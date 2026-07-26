import { decodeBase64Url, encodeBase64Url } from '../utils/base64url.js';

export const SESSION_ISSUANCE_BURST_WINDOW_MS = 60_000;
export const MAX_SESSION_ISSUANCE_BURST = 60;
export const SESSION_ISSUANCE_CAPACITY_WINDOW_MS = 43_200_000;
export const MAX_SESSION_ISSUANCE_CAPACITY = 512;
export const SESSION_ISSUANCE_RESERVATION_MS = 30_000;

export interface SessionIssuanceAllowed {
  readonly allowed: true;
}

export interface SessionIssuanceDenied {
  readonly allowed: false;
  readonly retryAt: number;
}

export type SessionIssuanceDecision = SessionIssuanceAllowed | SessionIssuanceDenied;

function isSafeTime(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function requireSafeTime(value: number): void {
  if (!isSafeTime(value)) {
    throw new Error('Session issuance time is invalid.');
  }
}

export function isSessionIssuanceReservationId(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    const decoded = decodeBase64Url(value);
    return decoded.byteLength === 24 && encodeBase64Url(decoded) === value;
  } catch {
    return false;
  }
}

export function pruneSessionIssuanceEvents(
  eventTimes: readonly number[],
  now: number,
): readonly number[] {
  requireSafeTime(now);
  if (!eventTimes.every(isSafeTime)) {
    throw new Error('Session issuance state is invalid.');
  }
  return eventTimes
    .filter((eventAt) => eventAt > now - SESSION_ISSUANCE_CAPACITY_WINDOW_MS)
    .sort((left, right) => left - right);
}

function blockingDeadline(
  sortedEventTimes: readonly number[],
  maximum: number,
  windowMs: number,
): number | null {
  if (sortedEventTimes.length < maximum) {
    return null;
  }
  const releaseIndex = sortedEventTimes.length - maximum;
  const eventAt = sortedEventTimes[releaseIndex];
  if (eventAt === undefined || eventAt > Number.MAX_SAFE_INTEGER - windowMs) {
    throw new Error('Session issuance deadline is invalid.');
  }
  return eventAt + windowMs;
}

export function decideSessionIssuance(
  eventTimes: readonly number[],
  now: number,
): SessionIssuanceDecision {
  const retained = pruneSessionIssuanceEvents(eventTimes, now);
  const burst = retained.filter((eventAt) => eventAt > now - SESSION_ISSUANCE_BURST_WINDOW_MS);
  const burstRetryAt = blockingDeadline(
    burst,
    MAX_SESSION_ISSUANCE_BURST,
    SESSION_ISSUANCE_BURST_WINDOW_MS,
  );
  const capacityRetryAt = blockingDeadline(
    retained,
    MAX_SESSION_ISSUANCE_CAPACITY,
    SESSION_ISSUANCE_CAPACITY_WINDOW_MS,
  );
  const deadlines = [burstRetryAt, capacityRetryAt].filter(
    (value): value is number => value !== null,
  );
  return deadlines.length === 0
    ? { allowed: true }
    : { allowed: false, retryAt: Math.max(...deadlines) };
}

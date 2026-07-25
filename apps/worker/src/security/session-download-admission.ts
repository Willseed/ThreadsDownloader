import { decodeBase64Url } from '../utils/base64url.js';

export const MAX_CONCURRENT_SESSION_DOWNLOADS = 4;
export const SESSION_DOWNLOAD_PERMIT_LEASE_MS = 90_000;
export const SESSION_DOWNLOAD_PERMIT_MIN_REMAINING_MS = 45_000;

export interface SessionDownloadPermit {
  readonly permitId: string;
  readonly downloadId: string;
  readonly sequence: number;
  readonly acquiredAt: number;
  readonly renewedAt: number;
  readonly expiresAt: number;
}

export interface SessionDownloadAdmissionState {
  readonly permits: readonly SessionDownloadPermit[];
}

export type SessionDownloadAdmissionStateErrorCode =
  | 'SESSION_DOWNLOAD_CONFLICT'
  | 'SESSION_DOWNLOAD_EXPIRED'
  | 'SESSION_DOWNLOAD_INVALID'
  | 'SESSION_DOWNLOAD_LIMIT';

export class SessionDownloadAdmissionStateError extends Error {
  constructor(readonly code: SessionDownloadAdmissionStateErrorCode) {
    super(code);
    this.name = 'SessionDownloadAdmissionStateError';
  }
}

function fail(code: SessionDownloadAdmissionStateErrorCode): never {
  throw new SessionDownloadAdmissionStateError(code);
}

function isSafeTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function hasCanonicalOpaqueBytes(
  value: unknown,
  characters: number,
  bytes: number,
): value is string {
  if (typeof value !== 'string' || value.length !== characters) {
    return false;
  }
  try {
    return decodeBase64Url(value).byteLength === bytes;
  } catch {
    return false;
  }
}

export function isSessionDownloadId(value: unknown): value is string {
  return hasCanonicalOpaqueBytes(value, 32, 24);
}

export function isSessionDownloadPermitId(value: unknown): value is string {
  return hasCanonicalOpaqueBytes(value, 32, 24);
}

export function isSessionIdentityHash(value: unknown): value is string {
  return hasCanonicalOpaqueBytes(value, 43, 32);
}

function clonePermit(permit: SessionDownloadPermit): SessionDownloadPermit {
  return { ...permit };
}

function samePermit(left: SessionDownloadPermit, right: SessionDownloadPermit): boolean {
  return (
    left.permitId === right.permitId &&
    left.downloadId === right.downloadId &&
    left.sequence === right.sequence &&
    left.acquiredAt === right.acquiredAt &&
    left.renewedAt === right.renewedAt &&
    left.expiresAt === right.expiresAt
  );
}

function validatePermit(permit: SessionDownloadPermit): void {
  if (
    !isSessionDownloadPermitId(permit.permitId) ||
    !isSessionDownloadId(permit.downloadId) ||
    !Number.isSafeInteger(permit.sequence) ||
    permit.sequence < 0 ||
    !isSafeTimestamp(permit.acquiredAt) ||
    !isSafeTimestamp(permit.renewedAt) ||
    !isSafeTimestamp(permit.expiresAt) ||
    permit.acquiredAt > permit.renewedAt ||
    permit.renewedAt >= permit.expiresAt ||
    permit.expiresAt - permit.renewedAt > SESSION_DOWNLOAD_PERMIT_LEASE_MS
  ) {
    fail('SESSION_DOWNLOAD_INVALID');
  }
}

function validateState(state: SessionDownloadAdmissionState): void {
  if (
    typeof state !== 'object' ||
    state === null ||
    !Array.isArray(state.permits) ||
    state.permits.length > MAX_CONCURRENT_SESSION_DOWNLOADS
  ) {
    fail('SESSION_DOWNLOAD_INVALID');
  }
  const ids = new Set<string>();
  for (const permit of state.permits) {
    validatePermit(permit);
    if (ids.has(permit.permitId)) {
      fail('SESSION_DOWNLOAD_INVALID');
    }
    ids.add(permit.permitId);
  }
}

function validateActiveSession(now: number, sessionExpiresAt: number): void {
  if (
    !isSafeTimestamp(now) ||
    !isSafeTimestamp(sessionExpiresAt) ||
    sessionExpiresAt - now < SESSION_DOWNLOAD_PERMIT_MIN_REMAINING_MS
  ) {
    fail('SESSION_DOWNLOAD_INVALID');
  }
}

export function pruneSessionDownloadPermits(
  state: SessionDownloadAdmissionState,
  now: number,
): SessionDownloadAdmissionState {
  validateState(state);
  if (!isSafeTimestamp(now)) {
    return fail('SESSION_DOWNLOAD_INVALID');
  }
  return {
    permits: state.permits.filter((permit) => permit.expiresAt > now).map(clonePermit),
  };
}

export function acquireSessionDownloadPermit(
  state: SessionDownloadAdmissionState,
  input: {
    readonly now: number;
    readonly sessionExpiresAt: number;
    readonly permitId: string;
    readonly downloadId: string;
  },
): { readonly state: SessionDownloadAdmissionState; readonly permit: SessionDownloadPermit } {
  validateActiveSession(input.now, input.sessionExpiresAt);
  if (
    !isSessionDownloadPermitId(input.permitId) ||
    !isSessionDownloadId(input.downloadId) ||
    input.now > Number.MAX_SAFE_INTEGER - SESSION_DOWNLOAD_PERMIT_LEASE_MS
  ) {
    return fail('SESSION_DOWNLOAD_INVALID');
  }
  const current = pruneSessionDownloadPermits(state, input.now);
  const existing = current.permits.find((permit) => permit.permitId === input.permitId);
  if (existing !== undefined) {
    if (existing.downloadId !== input.downloadId) {
      return fail('SESSION_DOWNLOAD_CONFLICT');
    }
    return { state: current, permit: clonePermit(existing) };
  }
  if (current.permits.length >= MAX_CONCURRENT_SESSION_DOWNLOADS) {
    return fail('SESSION_DOWNLOAD_LIMIT');
  }
  const permit: SessionDownloadPermit = {
    permitId: input.permitId,
    downloadId: input.downloadId,
    sequence: 0,
    acquiredAt: input.now,
    renewedAt: input.now,
    expiresAt: Math.min(input.sessionExpiresAt, input.now + SESSION_DOWNLOAD_PERMIT_LEASE_MS),
  };
  validatePermit(permit);
  return {
    state: { permits: [...current.permits.map(clonePermit), permit] },
    permit: clonePermit(permit),
  };
}

export function renewSessionDownloadPermit(
  state: SessionDownloadAdmissionState,
  input: {
    readonly now: number;
    readonly sessionExpiresAt: number;
    readonly permitId: string;
    readonly downloadId: string;
    readonly sequence: number;
  },
): { readonly state: SessionDownloadAdmissionState; readonly permit: SessionDownloadPermit } {
  validateActiveSession(input.now, input.sessionExpiresAt);
  if (
    !isSessionDownloadPermitId(input.permitId) ||
    !isSessionDownloadId(input.downloadId) ||
    !Number.isSafeInteger(input.sequence) ||
    input.sequence < 0 ||
    input.now > Number.MAX_SAFE_INTEGER - SESSION_DOWNLOAD_PERMIT_LEASE_MS
  ) {
    return fail('SESSION_DOWNLOAD_INVALID');
  }
  const current = pruneSessionDownloadPermits(state, input.now);
  const existing = current.permits.find((permit) => permit.permitId === input.permitId);
  if (existing === undefined) {
    return fail('SESSION_DOWNLOAD_EXPIRED');
  }
  if (existing.downloadId !== input.downloadId) {
    return fail('SESSION_DOWNLOAD_CONFLICT');
  }
  if (input.sequence === existing.sequence) {
    return { state: current, permit: clonePermit(existing) };
  }
  if (input.sequence !== existing.sequence + 1 || input.now < existing.renewedAt) {
    return fail('SESSION_DOWNLOAD_CONFLICT');
  }
  const renewed: SessionDownloadPermit = {
    ...clonePermit(existing),
    sequence: input.sequence,
    renewedAt: input.now,
    expiresAt: Math.min(input.sessionExpiresAt, input.now + SESSION_DOWNLOAD_PERMIT_LEASE_MS),
  };
  validatePermit(renewed);
  return {
    state: {
      permits: current.permits.map((permit) =>
        permit.permitId === input.permitId ? renewed : clonePermit(permit),
      ),
    },
    permit: clonePermit(renewed),
  };
}

export function releaseSessionDownloadPermit(
  state: SessionDownloadAdmissionState,
  input: {
    readonly now: number;
    readonly permitId: string;
    readonly downloadId: string;
  },
): SessionDownloadAdmissionState {
  if (!isSessionDownloadPermitId(input.permitId) || !isSessionDownloadId(input.downloadId)) {
    return fail('SESSION_DOWNLOAD_INVALID');
  }
  const current = pruneSessionDownloadPermits(state, input.now);
  const existing = current.permits.find((permit) => permit.permitId === input.permitId);
  if (existing !== undefined && existing.downloadId !== input.downloadId) {
    return fail('SESSION_DOWNLOAD_CONFLICT');
  }
  return {
    permits: current.permits
      .filter((permit) => permit.permitId !== input.permitId)
      .map(clonePermit),
  };
}

export function restoreSessionDownloadPermitAfterAlarmFailure(
  state: SessionDownloadAdmissionState,
  input: {
    readonly previous: SessionDownloadPermit;
    readonly attempted: SessionDownloadPermit;
  },
): SessionDownloadAdmissionState {
  validateState(state);
  validatePermit(input.previous);
  validatePermit(input.attempted);
  if (
    input.previous.permitId !== input.attempted.permitId ||
    input.previous.downloadId !== input.attempted.downloadId ||
    input.previous.acquiredAt !== input.attempted.acquiredAt ||
    input.attempted.sequence !== input.previous.sequence + 1 ||
    input.attempted.renewedAt < input.previous.renewedAt
  ) {
    return fail('SESSION_DOWNLOAD_INVALID');
  }
  return {
    permits: state.permits.map((permit) =>
      samePermit(permit, input.attempted) ? clonePermit(input.previous) : clonePermit(permit),
    ),
  };
}

export function nextSessionDownloadPermitDeadline(
  state: SessionDownloadAdmissionState,
): number | null {
  validateState(state);
  return state.permits.reduce<number | null>(
    (earliest, permit) =>
      earliest === null ? permit.expiresAt : Math.min(earliest, permit.expiresAt),
    null,
  );
}

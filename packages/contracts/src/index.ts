export const API_ERROR_CODES = [
  'HOST_NOT_ALLOWED',
  'SESSION_INVALID',
  'SESSION_EXPIRED',
  'SESSION_UNAVAILABLE',
  'REQUEST_INVALID',
  'REQUEST_TOO_LARGE',
  'URL_INVALID',
  'RATE_LIMITED',
  'TURNSTILE_INVALID',
  'TURNSTILE_UNAVAILABLE',
  'THREADS_LOGIN_REQUIRED',
  'THREADS_ACCESS_DENIED',
  'THREADS_RATE_LIMITED',
  'THREADS_BOT_BLOCKED',
  'THREADS_JAVASCRIPT_REQUIRED',
  'MEDIA_NOT_FOUND',
  'RESOLVE_UNAVAILABLE',
  'DOWNLOAD_EXPIRED',
  'DOWNLOAD_CONCURRENT_LIMIT',
  'DOWNLOAD_RANGE_UNAVAILABLE',
  'DOWNLOAD_UPSTREAM_UNAVAILABLE',
  'DOWNLOAD_UNAVAILABLE',
  'NOT_FOUND',
  'INTERNAL_ERROR',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiError {
  readonly error: {
    readonly code: ApiErrorCode;
    readonly message: string;
    readonly requestId: string;
  };
}

export interface HealthResponse {
  readonly status: 'ok';
  readonly requestId: string;
}

export interface SessionResponse {
  readonly csrfToken: string;
  readonly expiresAt: string;
  readonly turnstileSiteKey: string;
}

export interface ResolveRequest {
  readonly postUrl: string;
  readonly csrfToken: string;
  readonly turnstileToken: string;
  readonly rightsConfirmed: true;
}

export interface ResolveCandidate {
  readonly candidateId: string;
  readonly filename: string;
  readonly contentLength?: number;
}

export interface ResolveResponse {
  readonly resolveId: string;
  readonly expiresAt: string;
  readonly candidates: readonly ResolveCandidate[];
}

export interface DownloadSessionRequest {
  readonly resolveId: string;
  readonly candidateId: string;
  readonly csrfToken: string;
}

export interface DownloadSessionResponse {
  readonly downloadId: string;
  readonly downloadUrl: string;
  readonly startExpiresAt: string;
}

export type DownloadStatus = 'ISSUED' | 'ACTIVE' | 'INTERRUPTED' | 'COMPLETE_PENDING';

export type DownloadRangeCapability = 'bytes' | 'none' | 'unknown';

export interface DownloadStatusMetadata {
  readonly filename: string;
  readonly contentType: string;
  readonly contentLength: number | null;
  readonly rangeCapability: DownloadRangeCapability;
}

export interface DownloadStatusResponse {
  readonly available: true;
  readonly status: DownloadStatus;
  readonly startExpiresAt: string;
  readonly idleExpiresAt: string | null;
  readonly absoluteExpiresAt: string;
  readonly completionExpiresAt: string | null;
  readonly activeStreams: number;
  readonly metadata: DownloadStatusMetadata;
}

const OPAQUE_ID = /^[A-Za-z0-9_-]{32}$/u;
const CANONICAL_CSRF_TOKEN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const SAFE_FILENAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?$/u;
const VIDEO_MEDIA_TYPE = /^video\/[!#$%&'*+.^_`|~A-Za-z0-9-]+$/u;
const CANONICAL_ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SAFE_TURNSTILE_SITE_KEY = /^[A-Za-z0-9_-]{1,128}$/u;
const UNSAFE_PUBLIC_MESSAGE = /https?:\/\/|cdninstagram\.com/iu;
const MAX_API_ERROR_MESSAGE_CHARACTERS = 256;
const MAX_CONCURRENT_DOWNLOAD_STREAMS = 4;
const MAX_RESOLVE_CANDIDATES = 8;
const apiErrorCodes = new Set<string>(API_ERROR_CODES);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID.test(value);
}

function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && apiErrorCodes.has(value);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function isSafeApiErrorMessage(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_API_ERROR_MESSAGE_CHARACTERS &&
    value.trim() === value &&
    !hasControlCharacter(value) &&
    !UNSAFE_PUBLIC_MESSAGE.test(value)
  );
}

function isCanonicalCsrfToken(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_CSRF_TOKEN.test(value);
}

function isCanonicalIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !CANONICAL_ISO_DATE.test(value)) {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isoTimestamp(value: string): number {
  return Date.parse(value);
}

function isNullableCanonicalIsoDate(value: unknown): value is string | null {
  return value === null || isCanonicalIsoDate(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function decodeResolveCandidate(value: unknown): ResolveCandidate | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const hasContentLength = Object.hasOwn(value, 'contentLength');
  if (
    !hasExactKeys(
      value,
      hasContentLength ? ['candidateId', 'contentLength', 'filename'] : ['candidateId', 'filename'],
    ) ||
    !isOpaqueId(value['candidateId']) ||
    typeof value['filename'] !== 'string' ||
    value['filename'].length > 128 ||
    !SAFE_FILENAME.test(value['filename'])
  ) {
    return null;
  }
  if (!hasContentLength) {
    return { candidateId: value['candidateId'], filename: value['filename'] };
  }
  const contentLength = value['contentLength'];
  if (!isPositiveSafeInteger(contentLength)) {
    return null;
  }
  return { candidateId: value['candidateId'], filename: value['filename'], contentLength };
}

function isDownloadStatus(value: unknown): value is DownloadStatus {
  return (
    value === 'ISSUED' ||
    value === 'ACTIVE' ||
    value === 'INTERRUPTED' ||
    value === 'COMPLETE_PENDING'
  );
}

function isDownloadRangeCapability(value: unknown): value is DownloadRangeCapability {
  return value === 'bytes' || value === 'none' || value === 'unknown';
}

function isDownloadStatusMetadata(value: unknown): value is DownloadStatusMetadata {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ['contentLength', 'contentType', 'filename', 'rangeCapability']) &&
    typeof value['filename'] === 'string' &&
    value['filename'].length <= 128 &&
    SAFE_FILENAME.test(value['filename']) &&
    typeof value['contentType'] === 'string' &&
    VIDEO_MEDIA_TYPE.test(value['contentType']) &&
    (value['contentLength'] === null ||
      (typeof value['contentLength'] === 'number' &&
        Number.isSafeInteger(value['contentLength']) &&
        value['contentLength'] > 0)) &&
    isDownloadRangeCapability(value['rangeCapability'])
  );
}

function hasValidDownloadStatusShape(value: Record<string, unknown>): boolean {
  return (
    (value['status'] === 'ISSUED' &&
      value['idleExpiresAt'] === null &&
      value['completionExpiresAt'] === null &&
      value['activeStreams'] === 0) ||
    (value['status'] === 'ACTIVE' &&
      value['idleExpiresAt'] !== null &&
      value['completionExpiresAt'] === null &&
      typeof value['activeStreams'] === 'number' &&
      value['activeStreams'] >= 1) ||
    (value['status'] === 'INTERRUPTED' &&
      value['idleExpiresAt'] !== null &&
      value['completionExpiresAt'] === null &&
      value['activeStreams'] === 0) ||
    (value['status'] === 'COMPLETE_PENDING' &&
      value['idleExpiresAt'] !== null &&
      value['completionExpiresAt'] !== null &&
      value['activeStreams'] === 0)
  );
}

export function decodeApiError(value: unknown): ApiError | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ['error']) ||
    !isPlainObject(value['error']) ||
    !hasExactKeys(value['error'], ['code', 'message', 'requestId']) ||
    !isApiErrorCode(value['error']['code']) ||
    !isSafeApiErrorMessage(value['error']['message']) ||
    !isOpaqueId(value['error']['requestId'])
  ) {
    return null;
  }
  return {
    error: {
      code: value['error']['code'],
      message: value['error']['message'],
      requestId: value['error']['requestId'],
    },
  };
}

export function decodeSessionResponse(value: unknown): SessionResponse | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ['csrfToken', 'expiresAt', 'turnstileSiteKey']) ||
    !isCanonicalCsrfToken(value['csrfToken']) ||
    !isCanonicalIsoDate(value['expiresAt']) ||
    typeof value['turnstileSiteKey'] !== 'string' ||
    !SAFE_TURNSTILE_SITE_KEY.test(value['turnstileSiteKey'])
  ) {
    return null;
  }
  return {
    csrfToken: value['csrfToken'],
    expiresAt: value['expiresAt'],
    turnstileSiteKey: value['turnstileSiteKey'],
  };
}

export function decodeResolveResponse(value: unknown): ResolveResponse | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ['candidates', 'expiresAt', 'resolveId']) ||
    !isOpaqueId(value['resolveId']) ||
    !isCanonicalIsoDate(value['expiresAt']) ||
    !Array.isArray(value['candidates']) ||
    value['candidates'].length < 1 ||
    value['candidates'].length > MAX_RESOLVE_CANDIDATES
  ) {
    return null;
  }

  const candidates: ResolveCandidate[] = [];
  const candidateIds = new Set<string>();
  for (const candidate of value['candidates']) {
    const decoded = decodeResolveCandidate(candidate);
    if (decoded === null || candidateIds.has(decoded.candidateId)) {
      return null;
    }
    candidateIds.add(decoded.candidateId);
    candidates.push(decoded);
  }
  return { resolveId: value['resolveId'], expiresAt: value['expiresAt'], candidates };
}

export function decodeDownloadSessionRequest(value: unknown): DownloadSessionRequest | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ['candidateId', 'csrfToken', 'resolveId']) ||
    !isOpaqueId(value['resolveId']) ||
    !isOpaqueId(value['candidateId']) ||
    !isCanonicalCsrfToken(value['csrfToken'])
  ) {
    return null;
  }
  return {
    resolveId: value['resolveId'],
    candidateId: value['candidateId'],
    csrfToken: value['csrfToken'],
  };
}

export function decodeDownloadSessionResponse(value: unknown): DownloadSessionResponse | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ['downloadId', 'downloadUrl', 'startExpiresAt']) ||
    !isOpaqueId(value['downloadId']) ||
    value['downloadUrl'] !== `/api/download/${value['downloadId']}` ||
    !isCanonicalIsoDate(value['startExpiresAt'])
  ) {
    return null;
  }
  return {
    downloadId: value['downloadId'],
    downloadUrl: value['downloadUrl'],
    startExpiresAt: value['startExpiresAt'],
  };
}

export function decodeDownloadStatusResponse(value: unknown): DownloadStatusResponse | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      'absoluteExpiresAt',
      'activeStreams',
      'available',
      'completionExpiresAt',
      'idleExpiresAt',
      'metadata',
      'startExpiresAt',
      'status',
    ]) ||
    value['available'] !== true ||
    !isDownloadStatus(value['status']) ||
    !isCanonicalIsoDate(value['startExpiresAt']) ||
    !isNullableCanonicalIsoDate(value['idleExpiresAt']) ||
    !isCanonicalIsoDate(value['absoluteExpiresAt']) ||
    !isNullableCanonicalIsoDate(value['completionExpiresAt']) ||
    typeof value['activeStreams'] !== 'number' ||
    !Number.isSafeInteger(value['activeStreams']) ||
    value['activeStreams'] < 0 ||
    value['activeStreams'] > MAX_CONCURRENT_DOWNLOAD_STREAMS ||
    !isDownloadStatusMetadata(value['metadata']) ||
    !hasValidDownloadStatusShape(value)
  ) {
    return null;
  }

  const startExpiresAt = isoTimestamp(value['startExpiresAt']);
  const absoluteExpiresAt = isoTimestamp(value['absoluteExpiresAt']);
  const idleExpiresAt =
    value['idleExpiresAt'] === null ? null : isoTimestamp(value['idleExpiresAt']);
  const completionExpiresAt =
    value['completionExpiresAt'] === null ? null : isoTimestamp(value['completionExpiresAt']);
  if (
    startExpiresAt >= absoluteExpiresAt ||
    (idleExpiresAt !== null && idleExpiresAt > absoluteExpiresAt) ||
    (completionExpiresAt !== null &&
      (idleExpiresAt === null || completionExpiresAt > idleExpiresAt))
  ) {
    return null;
  }

  return {
    available: true,
    status: value['status'],
    startExpiresAt: value['startExpiresAt'],
    idleExpiresAt: value['idleExpiresAt'],
    absoluteExpiresAt: value['absoluteExpiresAt'],
    completionExpiresAt: value['completionExpiresAt'],
    activeStreams: value['activeStreams'],
    metadata: value['metadata'],
  };
}

export function createApiError(code: ApiErrorCode, message: string, requestId: string): ApiError {
  return { error: { code, message, requestId } };
}

import { decodeExactRecord } from './strict-json.js';

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
  readonly width?: number;
  readonly height?: number;
  readonly duration?: number;
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
const UNSAFE_PUBLIC_SCHEME = /https?:\/\//iu;
const DOMAIN_DOT_EQUIVALENT = /[\u3002\uFF0E\uFF61]/gu;
const DOMAIN_CANDIDATE = /[\p{L}\p{M}\p{N}.-]+/gu;
const IPV6_CANDIDATE = /[0-9A-Fa-f:.]+/gu;
const ASCII_DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u;
const ASCII_LETTER_TLD = /^[A-Za-z]{2,63}$/u;
const ASCII_PUNYCODE_TLD_BODY = /^[A-Za-z0-9-]+$/u;
const UNICODE_DOMAIN_CHARACTER = /^[\p{L}\p{M}\p{N}]$/u;
const HEXADECIMAL_CHARACTER = /^[0-9A-Fa-f]$/u;
const MAX_API_ERROR_MESSAGE_CHARACTERS = 256;
const MAX_CONCURRENT_DOWNLOAD_STREAMS = 4;
const MAX_RESOLVE_CANDIDATES = 8;
const apiErrorCodes = new Set<string>(API_ERROR_CODES);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID.test(value);
}

function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && apiErrorCodes.has(value);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (
      code === undefined ||
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0xd800 && code <= 0xdfff)
    ) {
      return true;
    }
  }
  return false;
}

function isAsciiTopLevelDomain(value: string): boolean {
  if (ASCII_LETTER_TLD.test(value)) {
    return true;
  }
  const lowercase = value.toLowerCase();
  const punycodeBody = lowercase.slice(4);
  return (
    lowercase.startsWith('xn--') &&
    lowercase.length <= 63 &&
    punycodeBody.length > 0 &&
    !punycodeBody.endsWith('-') &&
    ASCII_PUNYCODE_TLD_BODY.test(punycodeBody)
  );
}

function trimDomainDots(value: string): string {
  let start = 0;
  let end = value.length;
  while (value[start] === '.') {
    start += 1;
  }
  while (value[end - 1] === '.') {
    end -= 1;
  }
  return value.slice(start, end);
}

function isDomainLabel(value: string): boolean {
  if (value.length === 0 || value.length > 63 || value.startsWith('-') || value.endsWith('-')) {
    return false;
  }
  for (const character of value) {
    if (character !== '-' && !UNICODE_DOMAIN_CHARACTER.test(character)) {
      return false;
    }
  }
  return true;
}

function hasUnicodeCharacter(value: string): boolean {
  for (const character of value) {
    if (character.codePointAt(0)! > 0x7f) {
      return true;
    }
  }
  return false;
}

function hasDomain(value: string): boolean {
  const normalized = value.replaceAll(DOMAIN_DOT_EQUIVALENT, '.');
  const candidates = normalized.match(DOMAIN_CANDIDATE) ?? [];
  return candidates.some((candidate) => {
    const labels = trimDomainDots(candidate).split('.');
    const topLevelDomain = labels.at(-1);
    return (
      labels.length >= 2 &&
      topLevelDomain !== undefined &&
      labels.every((label) =>
        hasUnicodeCharacter(label) ? isDomainLabel(label) : ASCII_DOMAIN_LABEL.test(label),
      ) &&
      (isAsciiTopLevelDomain(topLevelDomain) ||
        (hasUnicodeCharacter(topLevelDomain) && isDomainLabel(topLevelDomain)))
    );
  });
}

function isIpv4(value: string): boolean {
  const parts = value.split('.');
  return (
    parts.length === 4 &&
    parts.every(
      (part) =>
        part.length >= 1 &&
        part.length <= 3 &&
        [...part].every((character) => character >= '0' && character <= '9') &&
        Number(part) <= 255,
    )
  );
}

function isHexadecimalSegment(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 4 &&
    [...value].every((character) => HEXADECIMAL_CHARACTER.test(character))
  );
}

function ipv6SegmentCount(parts: readonly string[]): number | null {
  let count = parts.length;
  for (const [index, part] of parts.entries()) {
    if (part.includes('.')) {
      if (index !== parts.length - 1 || !isIpv4(part)) {
        return null;
      }
      count += 1;
    } else if (!isHexadecimalSegment(part)) {
      return null;
    }
  }
  return count;
}

function isIpv6(value: string): boolean {
  if (!value.includes(':')) {
    return false;
  }
  const compression = value.indexOf('::');
  if (compression !== value.lastIndexOf('::')) {
    return false;
  }
  const compressed = compression !== -1;
  const left = compressed ? value.slice(0, compression) : value;
  const right = compressed ? value.slice(compression + 2) : '';
  const leftParts = left === '' ? [] : left.split(':');
  const rightParts = right === '' ? [] : right.split(':');
  const leftCount = ipv6SegmentCount(leftParts);
  const rightCount = ipv6SegmentCount(rightParts);
  if (leftCount === null || rightCount === null) {
    return false;
  }
  const total = leftCount + rightCount;
  return compressed ? total < 8 : total === 8;
}

function hasIpAddress(value: string): boolean {
  const normalized = value.replaceAll(DOMAIN_DOT_EQUIVALENT, '.');
  const domainCandidates = normalized.match(DOMAIN_CANDIDATE) ?? [];
  if (domainCandidates.some((candidate) => isIpv4(trimDomainDots(candidate)))) {
    return true;
  }
  return (normalized.match(IPV6_CANDIDATE) ?? []).some((candidate) =>
    isIpv6(trimDomainDots(candidate)),
  );
}

function hasReservedInternalHost(value: string): boolean {
  const normalized = value.replaceAll(DOMAIN_DOT_EQUIVALENT, '.');
  const candidates = normalized.match(DOMAIN_CANDIDATE) ?? [];
  return candidates.some((candidate) => {
    const lowercase = trimDomainDots(candidate).toLowerCase();
    return lowercase === 'localhost' || lowercase === 'localhost.localdomain';
  });
}

function isSafeApiErrorMessage(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_API_ERROR_MESSAGE_CHARACTERS &&
    value.trim() === value &&
    !hasControlCharacter(value) &&
    !UNSAFE_PUBLIC_SCHEME.test(value) &&
    !hasDomain(value) &&
    !hasIpAddress(value) &&
    !hasReservedInternalHost(value)
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

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

type ResolveCandidateMetadata = Pick<
  ResolveCandidate,
  'contentLength' | 'duration' | 'height' | 'width'
>;

function decodeResolveCandidateMetadata(
  value: Record<string, unknown>,
): ResolveCandidateMetadata | null {
  const metadata: {
    contentLength?: number;
    duration?: number;
    height?: number;
    width?: number;
  } = {};
  for (const field of ['contentLength', 'height', 'width'] as const) {
    if (!Object.hasOwn(value, field)) {
      continue;
    }
    const fieldValue = value[field];
    if (!isPositiveSafeInteger(fieldValue)) {
      return null;
    }
    metadata[field] = fieldValue;
  }
  if (Object.hasOwn(value, 'duration')) {
    const duration = value['duration'];
    if (!isPositiveFiniteNumber(duration)) {
      return null;
    }
    metadata.duration = duration;
  }
  return metadata;
}

function decodeResolveCandidate(value: unknown): ResolveCandidate | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const metadata = decodeResolveCandidateMetadata(value);
  const record =
    metadata === null
      ? null
      : decodeExactRecord(value, ['candidateId', 'filename', ...Object.keys(metadata)]);
  if (
    metadata === null ||
    record === null ||
    !isOpaqueId(record['candidateId']) ||
    typeof record['filename'] !== 'string' ||
    record['filename'].length > 128 ||
    !SAFE_FILENAME.test(record['filename'])
  ) {
    return null;
  }
  return { candidateId: record['candidateId'], filename: record['filename'], ...metadata };
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
  const record = decodeExactRecord(value, [
    'contentLength',
    'contentType',
    'filename',
    'rangeCapability',
  ]);
  return (
    record !== null &&
    typeof record['filename'] === 'string' &&
    record['filename'].length <= 128 &&
    SAFE_FILENAME.test(record['filename']) &&
    typeof record['contentType'] === 'string' &&
    VIDEO_MEDIA_TYPE.test(record['contentType']) &&
    (record['contentLength'] === null ||
      (typeof record['contentLength'] === 'number' &&
        Number.isSafeInteger(record['contentLength']) &&
        record['contentLength'] > 0)) &&
    isDownloadRangeCapability(record['rangeCapability'])
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
  const record = decodeExactRecord(value, ['error']);
  const error =
    record === null ? null : decodeExactRecord(record['error'], ['code', 'message', 'requestId']);
  if (
    error === null ||
    !isApiErrorCode(error['code']) ||
    !isSafeApiErrorMessage(error['message']) ||
    !isOpaqueId(error['requestId'])
  ) {
    return null;
  }
  return {
    error: {
      code: error['code'],
      message: error['message'],
      requestId: error['requestId'],
    },
  };
}

export function decodeSessionResponse(value: unknown): SessionResponse | null {
  const record = decodeExactRecord(value, ['csrfToken', 'expiresAt', 'turnstileSiteKey']);
  if (
    record === null ||
    !isCanonicalCsrfToken(record['csrfToken']) ||
    !isCanonicalIsoDate(record['expiresAt']) ||
    typeof record['turnstileSiteKey'] !== 'string' ||
    !SAFE_TURNSTILE_SITE_KEY.test(record['turnstileSiteKey'])
  ) {
    return null;
  }
  return {
    csrfToken: record['csrfToken'],
    expiresAt: record['expiresAt'],
    turnstileSiteKey: record['turnstileSiteKey'],
  };
}

export function decodeResolveResponse(value: unknown): ResolveResponse | null {
  const record = decodeExactRecord(value, ['candidates', 'expiresAt', 'resolveId']);
  if (
    record === null ||
    !isOpaqueId(record['resolveId']) ||
    !isCanonicalIsoDate(record['expiresAt']) ||
    !Array.isArray(record['candidates']) ||
    record['candidates'].length < 1 ||
    record['candidates'].length > MAX_RESOLVE_CANDIDATES
  ) {
    return null;
  }

  const candidates: ResolveCandidate[] = [];
  const candidateIds = new Set<string>();
  for (const candidate of record['candidates']) {
    const decoded = decodeResolveCandidate(candidate);
    if (decoded === null || candidateIds.has(decoded.candidateId)) {
      return null;
    }
    candidateIds.add(decoded.candidateId);
    candidates.push(decoded);
  }
  return { resolveId: record['resolveId'], expiresAt: record['expiresAt'], candidates };
}

export function decodeDownloadSessionRequest(value: unknown): DownloadSessionRequest | null {
  const record = decodeExactRecord(value, ['candidateId', 'csrfToken', 'resolveId']);
  if (
    record === null ||
    !isOpaqueId(record['resolveId']) ||
    !isOpaqueId(record['candidateId']) ||
    !isCanonicalCsrfToken(record['csrfToken'])
  ) {
    return null;
  }
  return {
    resolveId: record['resolveId'],
    candidateId: record['candidateId'],
    csrfToken: record['csrfToken'],
  };
}

export function decodeDownloadSessionResponse(value: unknown): DownloadSessionResponse | null {
  const record = decodeExactRecord(value, ['downloadId', 'downloadUrl', 'startExpiresAt']);
  if (
    record === null ||
    !isOpaqueId(record['downloadId']) ||
    record['downloadUrl'] !== `/api/download/${record['downloadId']}` ||
    !isCanonicalIsoDate(record['startExpiresAt'])
  ) {
    return null;
  }
  return {
    downloadId: record['downloadId'],
    downloadUrl: record['downloadUrl'],
    startExpiresAt: record['startExpiresAt'],
  };
}

export function decodeDownloadStatusResponse(value: unknown): DownloadStatusResponse | null {
  const record = decodeExactRecord(value, [
    'absoluteExpiresAt',
    'activeStreams',
    'available',
    'completionExpiresAt',
    'idleExpiresAt',
    'metadata',
    'startExpiresAt',
    'status',
  ]);
  if (
    record?.['available'] !== true ||
    !isDownloadStatus(record['status']) ||
    !isCanonicalIsoDate(record['startExpiresAt']) ||
    !isNullableCanonicalIsoDate(record['idleExpiresAt']) ||
    !isCanonicalIsoDate(record['absoluteExpiresAt']) ||
    !isNullableCanonicalIsoDate(record['completionExpiresAt']) ||
    typeof record['activeStreams'] !== 'number' ||
    !Number.isSafeInteger(record['activeStreams']) ||
    record['activeStreams'] < 0 ||
    record['activeStreams'] > MAX_CONCURRENT_DOWNLOAD_STREAMS ||
    !isDownloadStatusMetadata(record['metadata']) ||
    !hasValidDownloadStatusShape(record)
  ) {
    return null;
  }

  const startExpiresAt = isoTimestamp(record['startExpiresAt']);
  const absoluteExpiresAt = isoTimestamp(record['absoluteExpiresAt']);
  const idleExpiresAt =
    record['idleExpiresAt'] === null ? null : isoTimestamp(record['idleExpiresAt']);
  const completionExpiresAt =
    record['completionExpiresAt'] === null ? null : isoTimestamp(record['completionExpiresAt']);
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
    status: record['status'],
    startExpiresAt: record['startExpiresAt'],
    idleExpiresAt: record['idleExpiresAt'],
    absoluteExpiresAt: record['absoluteExpiresAt'],
    completionExpiresAt: record['completionExpiresAt'],
    activeStreams: record['activeStreams'],
    metadata: record['metadata'],
  };
}

export function createApiError(code: ApiErrorCode, message: string, requestId: string): ApiError {
  if (!isApiErrorCode(code) || !isSafeApiErrorMessage(message) || !isOpaqueId(requestId)) {
    throw new Error('API_ERROR_INVALID');
  }
  return { error: { code, message, requestId } };
}

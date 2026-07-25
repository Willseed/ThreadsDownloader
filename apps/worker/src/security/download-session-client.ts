import type { ProbedMedia } from '../resolver/media-probe.js';
import { decodeBase64Url } from '../utils/base64url.js';
import { createOpaqueId } from './cryptography.js';
import {
  DOWNLOAD_ABSOLUTE_LIFETIME_MS,
  DOWNLOAD_START_DEADLINE_MS,
  MAX_CONCURRENT_DOWNLOAD_STREAMS,
  type DownloadState,
  type DownloadStreamRequestPlan,
} from './download-session-state.js';
import { decideIfRange, parseSingleByteRange, type HeaderSource } from './range-transfer.js';
import type { ByteInterval, ReliableValidator, RepresentationPin } from './range-transfer.js';
import {
  decodeProbedMediaWire,
  encodeProbedMediaWire,
  type ProbedMediaWire,
} from './resolve-vault.js';

const DOWNLOAD_ID_CHARACTERS = 32;
const DOWNLOAD_ID_BYTES = 24;
const HOLDER_ID_CHARACTERS = 32;
const HOLDER_ID_BYTES = 24;
const SESSION_HASH_CHARACTERS = 43;
const SESSION_HASH_BYTES = 32;
const MAX_FILENAME_CHARACTERS = 128;
const MAX_FORWARDED_HEADER_CHARACTERS = 512;
const INTERNAL_ORIGIN = 'https://download-session.internal';
export const DOWNLOAD_SESSION_CLIENT_REQUEST_TIMEOUT_MS = 8_000;
const SAFE_FILENAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?$/u;
const SAFE_SHORTCODE = /^[A-Za-z0-9_-]{5,64}$/u;
const VIDEO_MEDIA_TYPE = /^video\/[!#$%&'*+.^_`|~A-Za-z0-9-]+$/u;

export interface DownloadSessionInitializeRequest {
  readonly downloadId: string;
  readonly sessionHash: string;
  readonly filename: string;
  readonly shortcode: string;
  readonly media: ProbedMedia;
}

export interface DownloadSessionIdentityRequest {
  readonly downloadId: string;
  readonly sessionHash: string;
}

export interface DownloadSessionAcquireRequest extends DownloadSessionIdentityRequest {
  readonly rangeHeader: string | null;
  readonly ifRangeHeader: string | null;
}

export interface DownloadSessionRenewRequest extends DownloadSessionIdentityRequest {
  readonly holderId: string;
  readonly sequence: number;
}

export interface DownloadSessionInterruptRequest extends DownloadSessionIdentityRequest {
  readonly holderId: string;
  readonly sequence: number;
}

export interface DownloadHeaderEvidence {
  readonly contentLength: string | null;
  readonly contentRange: string | null;
  readonly etag: string | null;
  readonly lastModified: string | null;
}

export interface DownloadSessionFinishRequest extends DownloadSessionIdentityRequest {
  readonly holderId: string;
  readonly sequence: number;
  readonly normalEof: boolean;
  readonly actualBytes: number;
  readonly upstream: {
    readonly status: 200 | 206;
    readonly headers: DownloadHeaderEvidence;
  };
}

export interface DownloadSessionInitializeWireRequest {
  readonly downloadId: string;
  readonly sessionHash: string;
  readonly filename: string;
  readonly shortcode: string;
  readonly media: ProbedMediaWire;
}

export interface DownloadSessionStub {
  fetch(request: Request): Promise<Response>;
}

export interface DownloadSessionNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DownloadSessionStub;
}

export interface InitializeDownloadSessionInput {
  readonly sessionHash: string;
  readonly filename: string;
  readonly shortcode: string;
  readonly media: ProbedMedia;
}

export interface InitializedDownloadSession {
  readonly downloadId: string;
  readonly issuedAt: number;
  readonly startExpiresAt: number;
  readonly absoluteExpiresAt: number;
}

export interface DownloadSessionStatus {
  readonly status: Exclude<DownloadState, 'EXPIRED'>;
  readonly available: true;
  readonly startExpiresAt: number;
  readonly idleExpiresAt: number | null;
  readonly absoluteExpiresAt: number;
  readonly completionExpiresAt: number | null;
  readonly activeStreams: number;
  readonly filename: string;
  readonly contentType: string;
  readonly contentLength: number | null;
  readonly strongEtag: string | null;
  readonly lastModified: string | null;
  readonly rangeCapability: ProbedMedia['rangeCapability'];
}

export interface DownloadSessionMetadataSnapshot {
  readonly filename: string;
  readonly contentType: string;
  readonly contentLength: number | null;
  readonly strongEtag: string | null;
  readonly lastModified: string | null;
  readonly rangeCapability: ProbedMedia['rangeCapability'];
}

export interface AcquiredDownloadStream {
  readonly holderId: string;
  readonly sequence: number;
  readonly expiresAt: number;
  readonly request: DownloadStreamRequestPlan;
  readonly media: ProbedMedia;
}

export interface RenewedDownloadStream {
  readonly holderId: string;
  readonly sequence: number;
  readonly expiresAt: number;
}

export type DownloadSessionClientErrorCode =
  | 'DOWNLOAD_SESSION_CONCURRENT_LIMIT'
  | 'DOWNLOAD_SESSION_CONFLICT'
  | 'DOWNLOAD_SESSION_EXPIRED'
  | 'DOWNLOAD_SESSION_RANGE_UNAVAILABLE'
  | 'DOWNLOAD_SESSION_REQUEST_INVALID'
  | 'DOWNLOAD_SESSION_UNAUTHORIZED'
  | 'DOWNLOAD_SESSION_UNAVAILABLE';

export type DownloadSessionClientErrorStatus = 400 | 401 | 409 | 410 | 416 | 429 | 503;

export class DownloadSessionClientError extends Error {
  declare readonly contentRange?: string;

  constructor(
    readonly code: DownloadSessionClientErrorCode,
    readonly status: DownloadSessionClientErrorStatus,
    contentRange?: string,
  ) {
    super(code);
    this.name = 'DownloadSessionClientError';
    if (contentRange !== undefined) {
      this.contentRange = contentRange;
    }
  }
}

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

function hasCanonicalBytes(value: unknown, characters: number, bytes: number): value is string {
  if (typeof value !== 'string' || value.length !== characters) {
    return false;
  }
  try {
    return decodeBase64Url(value).byteLength === bytes;
  } catch {
    return false;
  }
}

function isDownloadId(value: unknown): value is string {
  return hasCanonicalBytes(value, DOWNLOAD_ID_CHARACTERS, DOWNLOAD_ID_BYTES);
}

function isSessionHash(value: unknown): value is string {
  return hasCanonicalBytes(value, SESSION_HASH_CHARACTERS, SESSION_HASH_BYTES);
}

function isHolderId(value: unknown): value is string {
  return hasCanonicalBytes(value, HOLDER_ID_CHARACTERS, HOLDER_ID_BYTES);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isForwardedHeader(value: unknown): value is string | null {
  return (
    value === null || (typeof value === 'string' && value.length <= MAX_FORWARDED_HEADER_CHARACTERS)
  );
}

function decodeDownloadHeaderEvidence(value: unknown): DownloadHeaderEvidence | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ['contentLength', 'contentRange', 'etag', 'lastModified']) ||
    !isForwardedHeader(value['contentLength']) ||
    !isForwardedHeader(value['contentRange']) ||
    !isForwardedHeader(value['etag']) ||
    !isForwardedHeader(value['lastModified'])
  ) {
    return null;
  }
  return {
    contentLength: value['contentLength'],
    contentRange: value['contentRange'],
    etag: value['etag'],
    lastModified: value['lastModified'],
  };
}

export function encodeDownloadHeaderEvidence(headers: HeaderSource): DownloadHeaderEvidence {
  return {
    contentLength: headers.get('content-length'),
    contentRange: headers.get('content-range'),
    etag: headers.get('etag'),
    lastModified: headers.get('last-modified'),
  };
}

export function downloadHeaderEvidenceSource(evidence: DownloadHeaderEvidence): HeaderSource {
  const values: Readonly<Record<string, string | null>> = {
    'content-length': evidence.contentLength,
    'content-range': evidence.contentRange,
    etag: evidence.etag,
    'last-modified': evidence.lastModified,
  };
  return {
    get(name): string | null {
      return values[name.toLowerCase()] ?? null;
    },
  };
}

export function decodeDownloadSessionInitializeRequest(
  value: unknown,
): DownloadSessionInitializeRequest | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ['downloadId', 'filename', 'media', 'sessionHash', 'shortcode']) ||
    !isDownloadId(value['downloadId']) ||
    !isSessionHash(value['sessionHash']) ||
    typeof value['filename'] !== 'string' ||
    value['filename'].length > MAX_FILENAME_CHARACTERS ||
    !SAFE_FILENAME.test(value['filename']) ||
    typeof value['shortcode'] !== 'string' ||
    !SAFE_SHORTCODE.test(value['shortcode'])
  ) {
    return null;
  }
  const media = decodeProbedMediaWire(value['media']);
  return media === null
    ? null
    : {
        downloadId: value['downloadId'],
        sessionHash: value['sessionHash'],
        filename: value['filename'],
        shortcode: value['shortcode'],
        media,
      };
}

export function decodeDownloadSessionIdentityRequest(
  value: unknown,
): DownloadSessionIdentityRequest | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ['downloadId', 'sessionHash']) ||
    !isDownloadId(value['downloadId']) ||
    !isSessionHash(value['sessionHash'])
  ) {
    return null;
  }
  return { downloadId: value['downloadId'], sessionHash: value['sessionHash'] };
}

export function decodeDownloadSessionAcquireRequest(
  value: unknown,
): DownloadSessionAcquireRequest | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ['downloadId', 'ifRangeHeader', 'rangeHeader', 'sessionHash']) ||
    !isDownloadId(value['downloadId']) ||
    !isSessionHash(value['sessionHash']) ||
    !isForwardedHeader(value['rangeHeader']) ||
    !isForwardedHeader(value['ifRangeHeader'])
  ) {
    return null;
  }
  return {
    downloadId: value['downloadId'],
    sessionHash: value['sessionHash'],
    rangeHeader: value['rangeHeader'],
    ifRangeHeader: value['ifRangeHeader'],
  };
}

function decodeDownloadSessionLeaseRequest(value: unknown): DownloadSessionRenewRequest | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ['downloadId', 'holderId', 'sequence', 'sessionHash']) ||
    !isDownloadId(value['downloadId']) ||
    !isSessionHash(value['sessionHash']) ||
    !isHolderId(value['holderId']) ||
    !isSafeNonNegativeInteger(value['sequence'])
  ) {
    return null;
  }
  return {
    downloadId: value['downloadId'],
    sessionHash: value['sessionHash'],
    holderId: value['holderId'],
    sequence: value['sequence'],
  };
}

export function decodeDownloadSessionRenewRequest(
  value: unknown,
): DownloadSessionRenewRequest | null {
  return decodeDownloadSessionLeaseRequest(value);
}

export function decodeDownloadSessionInterruptRequest(
  value: unknown,
): DownloadSessionInterruptRequest | null {
  return decodeDownloadSessionLeaseRequest(value);
}

export function decodeDownloadSessionFinishRequest(
  value: unknown,
): DownloadSessionFinishRequest | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      'actualBytes',
      'downloadId',
      'holderId',
      'normalEof',
      'sequence',
      'sessionHash',
      'upstream',
    ]) ||
    !isDownloadId(value['downloadId']) ||
    !isSessionHash(value['sessionHash']) ||
    !isHolderId(value['holderId']) ||
    !isSafeNonNegativeInteger(value['sequence']) ||
    typeof value['normalEof'] !== 'boolean' ||
    !isSafeNonNegativeInteger(value['actualBytes']) ||
    !isPlainObject(value['upstream']) ||
    !hasExactKeys(value['upstream'], ['headers', 'status']) ||
    (value['upstream']['status'] !== 200 && value['upstream']['status'] !== 206)
  ) {
    return null;
  }
  const headers = decodeDownloadHeaderEvidence(value['upstream']['headers']);
  if (headers === null) {
    return null;
  }
  return {
    downloadId: value['downloadId'],
    sessionHash: value['sessionHash'],
    holderId: value['holderId'],
    sequence: value['sequence'],
    normalEof: value['normalEof'],
    actualBytes: value['actualBytes'],
    upstream: { status: value['upstream']['status'], headers },
  };
}

export interface DownloadSessionInitializeResponse {
  readonly ok: true;
  readonly issuedAt: number;
  readonly startExpiresAt: number;
  readonly absoluteExpiresAt: number;
}

export interface DownloadSessionStatusResponse extends DownloadSessionStatus {
  readonly ok: true;
}

export interface DownloadSessionAcquireResponse extends AcquiredDownloadStream {
  readonly ok: true;
}

export interface DownloadSessionRenewResponse extends RenewedDownloadStream {
  readonly ok: true;
}

export interface DownloadSessionAckResponse {
  readonly ok: true;
}

function isSafeTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isDownloadState(value: unknown): value is DownloadState {
  return (
    value === 'ISSUED' ||
    value === 'ACTIVE' ||
    value === 'INTERRUPTED' ||
    value === 'COMPLETE_PENDING' ||
    value === 'EXPIRED'
  );
}

function isStrongEtag(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length < 2 ||
    !value.startsWith('"') ||
    !value.endsWith('"')
  ) {
    return false;
  }
  for (let index = 1; index < value.length - 1; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 33 || code > 126 || code === 34) {
      return false;
    }
  }
  return true;
}

function isHttpDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toUTCString() === value
  );
}

function isRangeCapability(value: unknown): value is ProbedMedia['rangeCapability'] {
  return value === 'bytes' || value === 'none' || value === 'unknown';
}

function isReliableValidator(value: unknown): value is ReliableValidator {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ['kind', 'value']) ||
    typeof value['value'] !== 'string'
  ) {
    return false;
  }
  if (value['kind'] === 'etag') {
    return isStrongEtag(value['value']);
  }
  return value['kind'] === 'last-modified' && isHttpDate(value['value']);
}

function decodeByteInterval(value: unknown): ByteInterval | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ['end', 'start', 'total']) ||
    !isSafeNonNegativeInteger(value['start']) ||
    !isSafeNonNegativeInteger(value['end']) ||
    !isPositiveSafeInteger(value['total']) ||
    value['start'] > value['end'] ||
    value['end'] >= value['total']
  ) {
    return null;
  }
  return { start: value['start'], end: value['end'], total: value['total'] };
}

function decodeRepresentationPin(value: unknown): RepresentationPin | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ['total', 'validator']) ||
    !isPositiveSafeInteger(value['total']) ||
    !isReliableValidator(value['validator'])
  ) {
    return null;
  }
  return {
    total: value['total'],
    validator: { ...value['validator'] },
  };
}

function decodeDownloadStreamRequestPlan(value: unknown): DownloadStreamRequestPlan | null {
  if (!isPlainObject(value) || !hasExactKeys(value, ['representationPin', 'requestedInterval'])) {
    return null;
  }
  const requestedInterval =
    value['requestedInterval'] === null ? null : decodeByteInterval(value['requestedInterval']);
  const representationPin =
    value['representationPin'] === null
      ? null
      : decodeRepresentationPin(value['representationPin']);
  if (
    (value['requestedInterval'] !== null && requestedInterval === null) ||
    (value['representationPin'] !== null && representationPin === null)
  ) {
    return null;
  }
  return { requestedInterval, representationPin };
}

export function decodeDownloadSessionInitializeResponse(
  value: unknown,
): DownloadSessionInitializeResponse | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ['absoluteExpiresAt', 'issuedAt', 'ok', 'startExpiresAt']) ||
    value['ok'] !== true ||
    !isSafeTimestamp(value['issuedAt']) ||
    !isSafeTimestamp(value['startExpiresAt']) ||
    !isSafeTimestamp(value['absoluteExpiresAt']) ||
    value['issuedAt'] > Number.MAX_SAFE_INTEGER - DOWNLOAD_ABSOLUTE_LIFETIME_MS ||
    value['startExpiresAt'] !== value['issuedAt'] + DOWNLOAD_START_DEADLINE_MS ||
    value['absoluteExpiresAt'] !== value['issuedAt'] + DOWNLOAD_ABSOLUTE_LIFETIME_MS
  ) {
    return null;
  }
  return {
    ok: true,
    issuedAt: value['issuedAt'],
    startExpiresAt: value['startExpiresAt'],
    absoluteExpiresAt: value['absoluteExpiresAt'],
  };
}

export function decodeDownloadSessionStatusResponse(
  value: unknown,
): DownloadSessionStatusResponse | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      'absoluteExpiresAt',
      'activeStreams',
      'available',
      'completionExpiresAt',
      'contentLength',
      'contentType',
      'filename',
      'idleExpiresAt',
      'lastModified',
      'ok',
      'rangeCapability',
      'startExpiresAt',
      'status',
      'strongEtag',
    ]) ||
    value['ok'] !== true ||
    !isDownloadState(value['status']) ||
    value['available'] !== true ||
    value['status'] === 'EXPIRED' ||
    !isSafeTimestamp(value['startExpiresAt']) ||
    !isSafeTimestamp(value['absoluteExpiresAt']) ||
    value['startExpiresAt'] >= value['absoluteExpiresAt'] ||
    value['absoluteExpiresAt'] - value['startExpiresAt'] !==
      DOWNLOAD_ABSOLUTE_LIFETIME_MS - DOWNLOAD_START_DEADLINE_MS ||
    (value['idleExpiresAt'] !== null && !isSafeTimestamp(value['idleExpiresAt'])) ||
    (value['completionExpiresAt'] !== null && !isSafeTimestamp(value['completionExpiresAt'])) ||
    (typeof value['idleExpiresAt'] === 'number' &&
      value['idleExpiresAt'] > value['absoluteExpiresAt']) ||
    (typeof value['completionExpiresAt'] === 'number' &&
      value['completionExpiresAt'] > value['absoluteExpiresAt']) ||
    !isSafeNonNegativeInteger(value['activeStreams']) ||
    value['activeStreams'] > MAX_CONCURRENT_DOWNLOAD_STREAMS ||
    typeof value['filename'] !== 'string' ||
    value['filename'].length > MAX_FILENAME_CHARACTERS ||
    !SAFE_FILENAME.test(value['filename']) ||
    typeof value['contentType'] !== 'string' ||
    !VIDEO_MEDIA_TYPE.test(value['contentType']) ||
    (value['contentLength'] !== null && !isPositiveSafeInteger(value['contentLength'])) ||
    (value['strongEtag'] !== null && !isStrongEtag(value['strongEtag'])) ||
    (value['lastModified'] !== null && !isHttpDate(value['lastModified'])) ||
    !isRangeCapability(value['rangeCapability'])
  ) {
    return null;
  }
  const validStateShape =
    (value['status'] === 'ISSUED' &&
      value['idleExpiresAt'] === null &&
      value['completionExpiresAt'] === null &&
      value['activeStreams'] === 0) ||
    (value['status'] === 'ACTIVE' &&
      value['idleExpiresAt'] !== null &&
      value['completionExpiresAt'] === null &&
      value['activeStreams'] >= 1) ||
    (value['status'] === 'INTERRUPTED' &&
      value['idleExpiresAt'] !== null &&
      value['completionExpiresAt'] === null &&
      value['activeStreams'] === 0) ||
    (value['status'] === 'COMPLETE_PENDING' &&
      value['idleExpiresAt'] !== null &&
      value['completionExpiresAt'] !== null &&
      value['completionExpiresAt'] <= value['idleExpiresAt'] &&
      value['activeStreams'] === 0);
  if (!validStateShape) {
    return null;
  }
  return {
    ok: true,
    status: value['status'],
    available: value['available'],
    startExpiresAt: value['startExpiresAt'],
    idleExpiresAt: value['idleExpiresAt'],
    absoluteExpiresAt: value['absoluteExpiresAt'],
    completionExpiresAt: value['completionExpiresAt'],
    activeStreams: value['activeStreams'],
    filename: value['filename'],
    contentType: value['contentType'],
    contentLength: value['contentLength'],
    strongEtag: value['strongEtag'],
    lastModified: value['lastModified'],
    rangeCapability: value['rangeCapability'],
  };
}

export function decodeDownloadSessionAcquireResponse(
  value: unknown,
): DownloadSessionAcquireResponse | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ['expiresAt', 'holderId', 'media', 'ok', 'request', 'sequence']) ||
    value['ok'] !== true ||
    !isHolderId(value['holderId']) ||
    value['sequence'] !== 0 ||
    !isSafeTimestamp(value['expiresAt'])
  ) {
    return null;
  }
  const request = decodeDownloadStreamRequestPlan(value['request']);
  const media = decodeProbedMediaWire(value['media']);
  if (request === null || media === null) {
    return null;
  }
  const pin = request.representationPin;
  const hasReliableRepresentation = media.contentLength !== null && media.validator !== null;
  if (
    (pin !== null) !== hasReliableRepresentation ||
    (pin !== null &&
      (pin.total !== media.contentLength ||
        media.validator === null ||
        pin.validator.kind !== media.validator.kind ||
        pin.validator.value !== media.validator.value)) ||
    (request.requestedInterval !== null && request.requestedInterval.total !== media.contentLength)
  ) {
    return null;
  }
  return {
    ok: true,
    holderId: value['holderId'],
    sequence: value['sequence'],
    expiresAt: value['expiresAt'],
    request,
    media,
  };
}

export function decodeDownloadSessionRenewResponse(
  value: unknown,
): DownloadSessionRenewResponse | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ['expiresAt', 'holderId', 'ok', 'sequence']) ||
    value['ok'] !== true ||
    !isHolderId(value['holderId']) ||
    !isSafeNonNegativeInteger(value['sequence']) ||
    !isSafeTimestamp(value['expiresAt'])
  ) {
    return null;
  }
  return {
    ok: true,
    holderId: value['holderId'],
    sequence: value['sequence'],
    expiresAt: value['expiresAt'],
  };
}

export function decodeDownloadSessionAckResponse(
  value: unknown,
): DownloadSessionAckResponse | null {
  return isPlainObject(value) && hasExactKeys(value, ['ok']) && value['ok'] === true
    ? { ok: true }
    : null;
}

function invalidRequest(): never {
  throw new DownloadSessionClientError('DOWNLOAD_SESSION_REQUEST_INVALID', 400);
}

export function encodeDownloadSessionInitializeRequest(
  input: DownloadSessionInitializeRequest,
): DownloadSessionInitializeWireRequest {
  let media: ProbedMediaWire;
  try {
    media = encodeProbedMediaWire(input.media);
  } catch {
    return invalidRequest();
  }
  if (decodeDownloadSessionInitializeRequest({ ...input, media }) === null) {
    return invalidRequest();
  }
  return {
    downloadId: input.downloadId,
    sessionHash: input.sessionHash,
    filename: input.filename,
    shortcode: input.shortcode,
    media,
  };
}

export function encodeDownloadSessionIdentityRequest(
  input: DownloadSessionIdentityRequest,
): DownloadSessionIdentityRequest {
  const decoded = decodeDownloadSessionIdentityRequest(input);
  return decoded === null ? invalidRequest() : decoded;
}

export function encodeDownloadSessionAcquireRequest(
  input: DownloadSessionAcquireRequest,
): DownloadSessionAcquireRequest {
  const decoded = decodeDownloadSessionAcquireRequest(input);
  return decoded === null ? invalidRequest() : decoded;
}

export function encodeDownloadSessionRenewRequest(
  input: DownloadSessionRenewRequest,
): DownloadSessionRenewRequest {
  const decoded = decodeDownloadSessionRenewRequest(input);
  return decoded === null ? invalidRequest() : decoded;
}

export function encodeDownloadSessionFinishRequest(
  input: DownloadSessionFinishRequest,
): DownloadSessionFinishRequest {
  const decoded = decodeDownloadSessionFinishRequest(input);
  return decoded === null ? invalidRequest() : decoded;
}

export function encodeDownloadSessionInterruptRequest(
  input: DownloadSessionInterruptRequest,
): DownloadSessionInterruptRequest {
  const decoded = decodeDownloadSessionInterruptRequest(input);
  return decoded === null ? invalidRequest() : decoded;
}

function decodeUnsatisfiedContentRange(value: string | null): string | null {
  const match = /^bytes \*\/([1-9]\d*)$/u.exec(value ?? '');
  if (match === null) {
    return null;
  }
  const total = Number(match[1]);
  return Number.isSafeInteger(total) && total > 0 && String(total) === match[1] ? value : null;
}

function responseError(response: Response): DownloadSessionClientError {
  switch (response.status) {
    case 400:
      return new DownloadSessionClientError('DOWNLOAD_SESSION_REQUEST_INVALID', 400);
    case 401:
      return new DownloadSessionClientError('DOWNLOAD_SESSION_UNAUTHORIZED', 401);
    case 409:
      return new DownloadSessionClientError('DOWNLOAD_SESSION_CONFLICT', 409);
    case 410:
      return new DownloadSessionClientError('DOWNLOAD_SESSION_EXPIRED', 410);
    case 416: {
      const encodedContentRange = response.headers.get('content-range');
      if (encodedContentRange === null) {
        return new DownloadSessionClientError('DOWNLOAD_SESSION_RANGE_UNAVAILABLE', 416);
      }
      const contentRange = decodeUnsatisfiedContentRange(encodedContentRange);
      return contentRange === null
        ? unavailable()
        : new DownloadSessionClientError('DOWNLOAD_SESSION_RANGE_UNAVAILABLE', 416, contentRange);
    }
    case 429:
      return new DownloadSessionClientError('DOWNLOAD_SESSION_CONCURRENT_LIMIT', 429);
    default:
      return new DownloadSessionClientError('DOWNLOAD_SESSION_UNAVAILABLE', 503);
  }
}

function unavailable(): DownloadSessionClientError {
  return new DownloadSessionClientError('DOWNLOAD_SESSION_UNAVAILABLE', 503);
}

function getStub(namespace: DownloadSessionNamespace, downloadId: string): DownloadSessionStub {
  if (!isDownloadId(downloadId)) {
    return invalidRequest();
  }
  try {
    return namespace.get(namespace.idFromName(downloadId));
  } catch {
    throw unavailable();
  }
}

function jsonRequest(path: string, body: object): Request {
  return new Request(`${INTERNAL_ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function boundedClientOperation<T>(operation: () => Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(unavailable()), DOWNLOAD_SESSION_CLIENT_REQUEST_TIMEOUT_MS);
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), expired]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function boundedStubFetch(stub: DownloadSessionStub, request: Request): Promise<Response> {
  return boundedClientOperation(() => stub.fetch(request));
}

async function fetchJson<T>(
  stub: DownloadSessionStub,
  path: string,
  body: object,
  expectedStatus: number,
  decode: (value: unknown) => T | null,
  bounded = false,
): Promise<T> {
  const operation = async (): Promise<T> => {
    let response: Response;
    try {
      response = await stub.fetch(jsonRequest(path, body));
    } catch {
      throw unavailable();
    }
    if (response.status !== expectedStatus) {
      throw responseError(response);
    }
    if (response.headers.get('content-type') !== 'application/json') {
      throw unavailable();
    }
    try {
      const decoded = decode(await response.json());
      if (decoded === null) {
        throw unavailable();
      }
      return decoded;
    } catch (error: unknown) {
      if (error instanceof DownloadSessionClientError) {
        throw error;
      }
      throw unavailable();
    }
  };
  return bounded ? boundedClientOperation(operation) : operation();
}

async function bestEffortDestroy(
  stub: DownloadSessionStub,
  identity: DownloadSessionIdentityRequest,
): Promise<void> {
  try {
    await boundedStubFetch(stub, jsonRequest('/destroy', identity));
  } catch {
    // Initialization compensation is best-effort and cannot expose transport details.
  }
}

function decodeCanonicalPositiveInteger(value: string | null): number | null {
  if (value === null || !/^[1-9]\d*$/u.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && String(parsed) === value ? parsed : null;
}

export function decodeDownloadSessionMetadataHeaders(
  headers: Headers,
): DownloadSessionMetadataSnapshot | null {
  const filename = headers.get('x-download-filename');
  const contentType = headers.get('content-type');
  const encodedContentLength = headers.get('content-length');
  const contentLength = decodeCanonicalPositiveInteger(encodedContentLength);
  const strongEtag = headers.get('etag');
  const lastModified = headers.get('last-modified');
  const rangeCapability = headers.get('x-download-range-capability');
  if (
    filename === null ||
    filename.length > MAX_FILENAME_CHARACTERS ||
    !SAFE_FILENAME.test(filename) ||
    contentType === null ||
    !VIDEO_MEDIA_TYPE.test(contentType) ||
    (encodedContentLength !== null && contentLength === null) ||
    (strongEtag !== null && !isStrongEtag(strongEtag)) ||
    (lastModified !== null && !isHttpDate(lastModified)) ||
    !isRangeCapability(rangeCapability)
  ) {
    return null;
  }
  return {
    filename,
    contentType,
    contentLength,
    strongEtag,
    lastModified,
    rangeCapability,
  };
}

export async function initializeDownloadSession(
  namespace: DownloadSessionNamespace,
  input: InitializeDownloadSessionInput,
): Promise<InitializedDownloadSession> {
  let downloadId: string;
  try {
    downloadId = createOpaqueId(192);
  } catch {
    throw unavailable();
  }
  const request = encodeDownloadSessionInitializeRequest({ ...input, downloadId });
  const stub = getStub(namespace, downloadId);
  let decoded: DownloadSessionInitializeResponse;
  try {
    decoded = await boundedClientOperation(async () => {
      let response: Response;
      try {
        response = await stub.fetch(jsonRequest('/initialize', request));
      } catch {
        throw unavailable();
      }
      if (response.status !== 201) {
        throw responseError(response);
      }
      if (response.headers.get('content-type') !== 'application/json') {
        throw unavailable();
      }
      try {
        const result = decodeDownloadSessionInitializeResponse(await response.json());
        if (result === null) {
          throw unavailable();
        }
        return result;
      } catch (error: unknown) {
        if (error instanceof DownloadSessionClientError) {
          throw error;
        }
        throw unavailable();
      }
    });
  } catch (error: unknown) {
    if (error instanceof DownloadSessionClientError && error.code === 'DOWNLOAD_SESSION_CONFLICT') {
      throw error;
    }
    await bestEffortDestroy(stub, { downloadId, sessionHash: request.sessionHash });
    throw error instanceof DownloadSessionClientError ? error : unavailable();
  }
  return {
    downloadId,
    issuedAt: decoded.issuedAt,
    startExpiresAt: decoded.startExpiresAt,
    absoluteExpiresAt: decoded.absoluteExpiresAt,
  };
}

export async function inspectDownloadSession(
  namespace: DownloadSessionNamespace,
  input: DownloadSessionIdentityRequest,
): Promise<DownloadSessionMetadataSnapshot> {
  return boundedClientOperation(async () => {
    const identity = encodeDownloadSessionIdentityRequest(input);
    const stub = getStub(namespace, identity.downloadId);
    let response: Response;
    try {
      response = await stub.fetch(
        new Request(`${INTERNAL_ORIGIN}/inspect`, {
          method: 'HEAD',
          headers: {
            'x-download-id': identity.downloadId,
            'x-session-hash': identity.sessionHash,
          },
        }),
      );
    } catch {
      throw unavailable();
    }
    if (response.status !== 200) {
      throw responseError(response);
    }
    if (response.body !== null) {
      throw unavailable();
    }
    const metadata = decodeDownloadSessionMetadataHeaders(response.headers);
    if (metadata === null) {
      throw unavailable();
    }
    return metadata;
  });
}

export async function readDownloadSessionStatus(
  namespace: DownloadSessionNamespace,
  input: DownloadSessionIdentityRequest,
): Promise<DownloadSessionStatus> {
  const identity = encodeDownloadSessionIdentityRequest(input);
  const response = await fetchJson(
    getStub(namespace, identity.downloadId),
    '/status',
    identity,
    200,
    decodeDownloadSessionStatusResponse,
    true,
  );
  return {
    status: response.status,
    available: response.available,
    startExpiresAt: response.startExpiresAt,
    idleExpiresAt: response.idleExpiresAt,
    absoluteExpiresAt: response.absoluteExpiresAt,
    completionExpiresAt: response.completionExpiresAt,
    activeStreams: response.activeStreams,
    filename: response.filename,
    contentType: response.contentType,
    contentLength: response.contentLength,
    strongEtag: response.strongEtag,
    lastModified: response.lastModified,
    rangeCapability: response.rangeCapability,
  };
}

export async function acquireDownloadSessionStream(
  namespace: DownloadSessionNamespace,
  input: DownloadSessionAcquireRequest,
): Promise<AcquiredDownloadStream> {
  const request = encodeDownloadSessionAcquireRequest(input);
  const response = await fetchJson(
    getStub(namespace, request.downloadId),
    '/acquire',
    request,
    201,
    decodeDownloadSessionAcquireResponse,
  );
  let expectedInterval: ByteInterval | null = null;
  if (
    request.rangeHeader !== null &&
    decideIfRange(request.ifRangeHeader, response.media.validator) === 'range'
  ) {
    if (response.media.rangeCapability === 'none') {
      throw unavailable();
    }
    if (response.media.contentLength === null) {
      throw unavailable();
    }
    try {
      expectedInterval = parseSingleByteRange(request.rangeHeader, response.media.contentLength);
    } catch {
      throw unavailable();
    }
  }
  const actualInterval = response.request.requestedInterval;
  if (
    (actualInterval === null) !== (expectedInterval === null) ||
    (actualInterval !== null &&
      expectedInterval !== null &&
      (actualInterval.start !== expectedInterval.start ||
        actualInterval.end !== expectedInterval.end ||
        actualInterval.total !== expectedInterval.total))
  ) {
    throw unavailable();
  }
  return {
    holderId: response.holderId,
    sequence: response.sequence,
    expiresAt: response.expiresAt,
    request: response.request,
    media: response.media,
  };
}

export async function renewDownloadSessionStream(
  namespace: DownloadSessionNamespace,
  input: DownloadSessionRenewRequest,
): Promise<RenewedDownloadStream> {
  const request = encodeDownloadSessionRenewRequest(input);
  const response = await fetchJson(
    getStub(namespace, request.downloadId),
    '/renew',
    request,
    200,
    decodeDownloadSessionRenewResponse,
  );
  if (response.holderId !== request.holderId || response.sequence !== request.sequence) {
    throw unavailable();
  }
  return {
    holderId: response.holderId,
    sequence: response.sequence,
    expiresAt: response.expiresAt,
  };
}

export async function finishDownloadSessionStream(
  namespace: DownloadSessionNamespace,
  input: DownloadSessionFinishRequest,
): Promise<void> {
  const request = encodeDownloadSessionFinishRequest(input);
  await fetchJson(
    getStub(namespace, request.downloadId),
    '/finish',
    request,
    200,
    decodeDownloadSessionAckResponse,
  );
}

export async function interruptDownloadSessionStream(
  namespace: DownloadSessionNamespace,
  input: DownloadSessionInterruptRequest,
): Promise<void> {
  const request = encodeDownloadSessionInterruptRequest(input);
  await fetchJson(
    getStub(namespace, request.downloadId),
    '/interrupt',
    request,
    200,
    decodeDownloadSessionAckResponse,
  );
}

export async function destroyDownloadSession(
  namespace: DownloadSessionNamespace,
  input: DownloadSessionIdentityRequest,
): Promise<void> {
  const identity = encodeDownloadSessionIdentityRequest(input);
  await fetchJson(
    getStub(namespace, identity.downloadId),
    '/destroy',
    identity,
    200,
    decodeDownloadSessionAckResponse,
    true,
  );
}

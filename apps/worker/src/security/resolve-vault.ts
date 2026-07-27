import { decodeExactRecord } from '@threads-downloader/contracts/strict-json';

import { normalizeProbedMedia, type ProbedMedia } from '../resolver/media-probe.js';
import { decodeBase64Url } from '../utils/base64url.js';
import { createOpaqueId } from './cryptography.js';
import type { BrowserSessionIdentity, SessionNamespace } from './session-client.js';

export const RESOLVE_VAULT_MAX_BATCHES = 5;
export const RESOLVE_VAULT_MAX_CANDIDATES = 50;
export const RESOLVE_VAULT_MAX_BATCH_CANDIDATES = 10;
export const RESOLVE_VAULT_TTL_MS = 600_000;
export const RESOLVE_VAULT_STAGING_MS = 30_000;
export const RESOLVE_VAULT_RESERVATION_MS = 30_000;
export const RESOLVE_VAULT_REQUEST_TIMEOUT_MS = 8_000;

const SESSION_HASH_CHARACTERS = 43;
const SESSION_HASH_BYTES = 32;
const OPAQUE_ID_CHARACTERS = 32;
const OPAQUE_ID_BYTES = 24;
const MINIMUM_PERMIT_BYTES = 16;
const SHORTCODE = /^[A-Za-z0-9_-]{5,64}$/u;
const SAFE_FILENAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?$/u;
const PROBED_MEDIA_WIRE_FIELDS = [
  'completionReliable',
  'contentLength',
  'contentType',
  'finalUrl',
  'lastModified',
  'probeMethod',
  'rangeCapability',
  'strongEtag',
] as const;

export interface ProbedMediaWire {
  readonly finalUrl: string;
  readonly contentType: string;
  readonly contentLength: number | null;
  readonly rangeCapability: ProbedMedia['rangeCapability'];
  readonly strongEtag: string | null;
  readonly lastModified: string | null;
  readonly completionReliable: boolean;
  readonly probeMethod: ProbedMedia['probeMethod'];
}

export interface ResolveVaultStoreRequest {
  readonly sessionHash: string;
  readonly csrfHash: string;
  readonly permitId: string;
  readonly now: number;
  readonly shortcode: string;
  readonly candidates: readonly ProbedMedia[];
}

export interface ResolveVaultClaimRequest {
  readonly sessionHash: string;
  readonly csrfHash: string;
  readonly now: number;
  readonly resolveId: string;
  readonly candidateId: string;
  readonly reservationId: string;
}

export interface ResolveVaultSettleRequest extends ResolveVaultClaimRequest {
  readonly outcome: 'consume' | 'release';
}

export interface SafeResolvedMediaCandidate {
  readonly candidateId: string;
  readonly filename: string;
  readonly contentLength?: number;
}

export interface StoredResolvedMediaBatch {
  readonly resolveId: string;
  readonly expiresAt: number;
  readonly candidates: readonly SafeResolvedMediaCandidate[];
}

export interface ResolvedMediaClaim {
  readonly reservationId: string;
  readonly reservationExpiresAt: number;
  readonly filename: string;
  readonly shortcode: string;
  readonly media: ProbedMedia;
}

export type ResolveVaultErrorCode =
  | 'RESOLVE_VAULT_CAPACITY'
  | 'RESOLVE_VAULT_CONFLICT'
  | 'RESOLVE_VAULT_INVALID'
  | 'RESOLVE_VAULT_NOT_FOUND'
  | 'RESOLVE_VAULT_UNAVAILABLE'
  | 'SESSION_INVALID';

export class ResolveVaultError extends Error {
  constructor(readonly code: ResolveVaultErrorCode) {
    super(code);
    this.name = 'ResolveVaultError';
  }
}

export interface StoreResolvedMediaBatchInput {
  readonly sessions: SessionNamespace;
  readonly identity: BrowserSessionIdentity;
  readonly csrfHash: string;
  readonly permitId: string;
  readonly shortcode: string;
  readonly candidates: readonly ProbedMedia[];
  readonly now?: number;
  readonly clock?: () => number;
}

export interface ClaimResolvedMediaCandidateInput {
  readonly sessions: SessionNamespace;
  readonly identity: BrowserSessionIdentity;
  readonly csrfHash: string;
  readonly resolveId: string;
  readonly candidateId: string;
  readonly now?: number;
  readonly clock?: () => number;
}

export interface SettleResolvedMediaClaimInput extends ClaimResolvedMediaCandidateInput {
  readonly reservationId: string;
  readonly outcome: 'consume' | 'release';
}

function fail(code: ResolveVaultErrorCode): never {
  throw new ResolveVaultError(code);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasCanonicalBytes(
  value: unknown,
  characters: number | null,
  minimumBytes: number,
  exactBytes?: number,
): value is string {
  if (typeof value !== 'string' || (characters !== null && value.length !== characters)) {
    return false;
  }
  try {
    const bytes = decodeBase64Url(value).byteLength;
    return exactBytes === undefined ? bytes >= minimumBytes : bytes === exactBytes;
  } catch {
    return false;
  }
}

function isSessionHash(value: unknown): value is string {
  return hasCanonicalBytes(value, SESSION_HASH_CHARACTERS, SESSION_HASH_BYTES, SESSION_HASH_BYTES);
}

function isOpaqueId(value: unknown): value is string {
  return hasCanonicalBytes(value, OPAQUE_ID_CHARACTERS, OPAQUE_ID_BYTES, OPAQUE_ID_BYTES);
}

function isPermitId(value: unknown): value is string {
  return hasCanonicalBytes(value, null, MINIMUM_PERMIT_BYTES);
}

function isSafeTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedServerDeadline(
  anchor: unknown,
  deadline: unknown,
  receivedAt: number,
  lifetime: number,
): deadline is number {
  return (
    isSafeTimestamp(anchor) &&
    isSafeTimestamp(deadline) &&
    isSafeTimestamp(receivedAt) &&
    anchor <= receivedAt &&
    deadline > receivedAt &&
    deadline > anchor &&
    deadline - anchor <= lifetime
  );
}

function responseTime(clock: () => number): number {
  try {
    const value = clock();
    return isSafeTimestamp(value) ? value : fail('RESOLVE_VAULT_UNAVAILABLE');
  } catch {
    return fail('RESOLVE_VAULT_UNAVAILABLE');
  }
}

function isContentLength(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
}

export function encodeProbedMediaWire(media: ProbedMedia): ProbedMediaWire {
  let normalized: ProbedMedia;
  try {
    normalized = normalizeProbedMedia(media);
  } catch {
    return fail('RESOLVE_VAULT_INVALID');
  }
  return {
    finalUrl: normalized.finalUrl.url.href,
    contentType: normalized.contentType,
    contentLength: normalized.contentLength,
    rangeCapability: normalized.rangeCapability,
    strongEtag: normalized.strongEtag,
    lastModified: normalized.lastModified,
    completionReliable: normalized.completionReliable,
    probeMethod: normalized.probeMethod,
  };
}

export function decodeProbedMediaWire(value: unknown): ProbedMedia | null {
  const record = decodeExactRecord(value, PROBED_MEDIA_WIRE_FIELDS);
  if (record === null) {
    return null;
  }
  try {
    return normalizeProbedMedia(record);
  } catch {
    return null;
  }
}

export function deriveResolvedMediaFilename(
  shortcode: string,
  ordinal: number,
  contentType: string,
): string {
  if (
    !SHORTCODE.test(shortcode) ||
    !Number.isSafeInteger(ordinal) ||
    ordinal < 1 ||
    ordinal > RESOLVE_VAULT_MAX_BATCH_CANDIDATES
  ) {
    return fail('RESOLVE_VAULT_INVALID');
  }
  const extension =
    new Map<string, string>([
      ['video/mp4', 'mp4'],
      ['video/quicktime', 'mov'],
      ['video/webm', 'webm'],
      ['video/x-m4v', 'm4v'],
    ]).get(contentType) ?? 'video';
  return `threads_${shortcode}_${String(ordinal)}.${extension}`;
}

export function decodeResolveVaultStoreRequest(value: unknown): ResolveVaultStoreRequest | null {
  const record = decodeExactRecord(value, [
    'candidates',
    'csrfHash',
    'now',
    'permitId',
    'sessionHash',
    'shortcode',
  ]);
  if (
    record === null ||
    !isSessionHash(record['sessionHash']) ||
    !isSessionHash(record['csrfHash']) ||
    !isPermitId(record['permitId']) ||
    !isSafeTimestamp(record['now']) ||
    typeof record['shortcode'] !== 'string' ||
    !SHORTCODE.test(record['shortcode']) ||
    !Array.isArray(record['candidates']) ||
    record['candidates'].length < 1 ||
    record['candidates'].length > RESOLVE_VAULT_MAX_BATCH_CANDIDATES
  ) {
    return null;
  }
  const candidates: ProbedMedia[] = [];
  for (const candidate of record['candidates']) {
    const decoded = decodeProbedMediaWire(candidate);
    if (decoded === null) {
      return null;
    }
    candidates.push(decoded);
  }
  return {
    sessionHash: record['sessionHash'],
    csrfHash: record['csrfHash'],
    permitId: record['permitId'],
    now: record['now'],
    shortcode: record['shortcode'],
    candidates,
  };
}

export function decodeResolveVaultClaimRequest(value: unknown): ResolveVaultClaimRequest | null {
  const record = decodeExactRecord(value, [
    'candidateId',
    'csrfHash',
    'now',
    'reservationId',
    'resolveId',
    'sessionHash',
  ]);
  if (
    record === null ||
    !isSessionHash(record['sessionHash']) ||
    !isSessionHash(record['csrfHash']) ||
    !isSafeTimestamp(record['now']) ||
    !isOpaqueId(record['resolveId']) ||
    !isOpaqueId(record['candidateId']) ||
    !isOpaqueId(record['reservationId'])
  ) {
    return null;
  }
  return {
    sessionHash: record['sessionHash'],
    csrfHash: record['csrfHash'],
    now: record['now'],
    resolveId: record['resolveId'],
    candidateId: record['candidateId'],
    reservationId: record['reservationId'],
  };
}

export function decodeResolveVaultSettleRequest(value: unknown): ResolveVaultSettleRequest | null {
  const record = decodeExactRecord(value, [
    'candidateId',
    'csrfHash',
    'now',
    'outcome',
    'reservationId',
    'resolveId',
    'sessionHash',
  ]);
  if (record === null) {
    return null;
  }
  const claim = decodeResolveVaultClaimRequest({
    sessionHash: record['sessionHash'],
    csrfHash: record['csrfHash'],
    now: record['now'],
    resolveId: record['resolveId'],
    candidateId: record['candidateId'],
    reservationId: record['reservationId'],
  });
  if (claim === null || (record['outcome'] !== 'consume' && record['outcome'] !== 'release')) {
    return null;
  }
  return { ...claim, outcome: record['outcome'] };
}

function mapStatus(status: number): never {
  if (status === 400) {
    return fail('RESOLVE_VAULT_INVALID');
  }
  if (status === 401) {
    return fail('SESSION_INVALID');
  }
  if (status === 404) {
    return fail('RESOLVE_VAULT_NOT_FOUND');
  }
  if (status === 409) {
    return fail('RESOLVE_VAULT_CONFLICT');
  }
  if (status === 429) {
    return fail('RESOLVE_VAULT_CAPACITY');
  }
  return fail('RESOLVE_VAULT_UNAVAILABLE');
}

async function internalPost(
  sessions: SessionNamespace,
  identity: BrowserSessionIdentity,
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const stub = sessions.get(sessions.idFromName(identity.rawId));
    const request = new Request(`https://session.internal${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const expired = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new ResolveVaultError('RESOLVE_VAULT_UNAVAILABLE')),
        RESOLVE_VAULT_REQUEST_TIMEOUT_MS,
      );
    });
    return await Promise.race([stub.fetch(request), expired]);
  } catch {
    return fail('RESOLVE_VAULT_UNAVAILABLE');
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function decodeSafeCandidate(value: unknown): SafeResolvedMediaCandidate | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const hasLength = Object.hasOwn(value, 'contentLength');
  const record = decodeExactRecord(
    value,
    hasLength ? ['candidateId', 'contentLength', 'filename'] : ['candidateId', 'filename'],
  );
  if (
    record === null ||
    !isOpaqueId(record['candidateId']) ||
    typeof record['filename'] !== 'string' ||
    !SAFE_FILENAME.test(record['filename']) ||
    (hasLength && !isContentLength(record['contentLength'])) ||
    record['contentLength'] === null
  ) {
    return null;
  }
  return hasLength
    ? {
        candidateId: record['candidateId'],
        filename: record['filename'],
        contentLength: record['contentLength'] as number,
      }
    : { candidateId: record['candidateId'], filename: record['filename'] };
}

async function readJson(response: Response): Promise<unknown> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const expired = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new ResolveVaultError('RESOLVE_VAULT_UNAVAILABLE')),
        RESOLVE_VAULT_REQUEST_TIMEOUT_MS,
      );
    });
    return await Promise.race([response.json(), expired]);
  } catch {
    return fail('RESOLVE_VAULT_UNAVAILABLE');
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

export async function storeResolvedMediaBatch(
  input: StoreResolvedMediaBatchInput,
): Promise<StoredResolvedMediaBatch> {
  const clock = input.clock ?? Date.now;
  const now = input.now ?? responseTime(clock);
  if (!isSafeTimestamp(now) || now > Number.MAX_SAFE_INTEGER - RESOLVE_VAULT_TTL_MS) {
    return fail('RESOLVE_VAULT_INVALID');
  }
  let candidates: ProbedMediaWire[];
  try {
    candidates = input.candidates.map(encodeProbedMediaWire);
  } catch {
    return fail('RESOLVE_VAULT_INVALID');
  }
  const response = await internalPost(input.sessions, input.identity, '/resolve-vault/store', {
    sessionHash: input.identity.sessionHash,
    csrfHash: input.csrfHash,
    permitId: input.permitId,
    now,
    shortcode: input.shortcode,
    candidates,
  });
  if (response.status !== 201) {
    return mapStatus(response.status);
  }
  const body = await readJson(response);
  const receivedAt = responseTime(clock);
  const record = decodeExactRecord(body, [
    'candidates',
    'expiresAt',
    'issuedAt',
    'ok',
    'resolveId',
  ]);
  if (
    record === null ||
    record['ok'] !== true ||
    !isOpaqueId(record['resolveId']) ||
    !isBoundedServerDeadline(
      record['issuedAt'],
      record['expiresAt'],
      receivedAt,
      RESOLVE_VAULT_TTL_MS,
    ) ||
    !Array.isArray(record['candidates']) ||
    record['candidates'].length !== candidates.length
  ) {
    return fail('RESOLVE_VAULT_UNAVAILABLE');
  }
  const safeCandidates: SafeResolvedMediaCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of record['candidates']) {
    const decoded = decodeSafeCandidate(candidate);
    if (decoded === null || seen.has(decoded.candidateId)) {
      return fail('RESOLVE_VAULT_UNAVAILABLE');
    }
    seen.add(decoded.candidateId);
    safeCandidates.push(decoded);
  }
  return {
    resolveId: record['resolveId'],
    expiresAt: record['expiresAt'],
    candidates: safeCandidates,
  };
}

export async function claimResolvedMediaCandidate(
  input: ClaimResolvedMediaCandidateInput,
): Promise<ResolvedMediaClaim> {
  const clock = input.clock ?? Date.now;
  const now = input.now ?? responseTime(clock);
  if (!isSafeTimestamp(now) || now > Number.MAX_SAFE_INTEGER - RESOLVE_VAULT_RESERVATION_MS) {
    return fail('RESOLVE_VAULT_INVALID');
  }
  let reservationId: string;
  try {
    reservationId = createOpaqueId(192);
  } catch {
    return fail('RESOLVE_VAULT_UNAVAILABLE');
  }
  const requestBody = {
    sessionHash: input.identity.sessionHash,
    csrfHash: input.csrfHash,
    now,
    resolveId: input.resolveId,
    candidateId: input.candidateId,
    reservationId,
  };
  let response: Response;
  try {
    response = await internalPost(
      input.sessions,
      input.identity,
      '/resolve-vault/claim',
      requestBody,
    );
  } catch (error: unknown) {
    if (!(error instanceof ResolveVaultError) || error.code !== 'RESOLVE_VAULT_UNAVAILABLE') {
      throw error;
    }
    try {
      response = await internalPost(
        input.sessions,
        input.identity,
        '/resolve-vault/claim',
        requestBody,
      );
    } catch {
      await bestEffortRelease(input, reservationId);
      return fail('RESOLVE_VAULT_UNAVAILABLE');
    }
  }
  if (response.status !== 200) {
    return mapStatus(response.status);
  }
  let body: unknown;
  try {
    body = await readJson(response);
  } catch {
    await bestEffortRelease(input, reservationId);
    return fail('RESOLVE_VAULT_UNAVAILABLE');
  }
  let receivedAt: number;
  try {
    receivedAt = responseTime(clock);
  } catch {
    await bestEffortRelease(input, reservationId);
    return fail('RESOLVE_VAULT_UNAVAILABLE');
  }
  const record = decodeExactRecord(body, [
    'filename',
    'grant',
    'ok',
    'reservationExpiresAt',
    'reservationId',
    'reservedAt',
    'shortcode',
  ]);
  if (
    record === null ||
    record['ok'] !== true ||
    record['reservationId'] !== reservationId ||
    typeof record['filename'] !== 'string' ||
    !SAFE_FILENAME.test(record['filename']) ||
    typeof record['shortcode'] !== 'string' ||
    !SHORTCODE.test(record['shortcode']) ||
    !isBoundedServerDeadline(
      record['reservedAt'],
      record['reservationExpiresAt'],
      receivedAt,
      RESOLVE_VAULT_RESERVATION_MS,
    )
  ) {
    await bestEffortRelease(input, reservationId);
    return fail('RESOLVE_VAULT_UNAVAILABLE');
  }
  const media = decodeProbedMediaWire(record['grant']);
  if (media === null) {
    await bestEffortRelease(input, reservationId);
    return fail('RESOLVE_VAULT_UNAVAILABLE');
  }
  return {
    reservationId,
    reservationExpiresAt: record['reservationExpiresAt'],
    filename: record['filename'],
    shortcode: record['shortcode'],
    media,
  };
}

async function bestEffortRelease(
  input: ClaimResolvedMediaCandidateInput,
  reservationId: string,
): Promise<void> {
  try {
    await internalPost(input.sessions, input.identity, '/resolve-vault/settle', {
      sessionHash: input.identity.sessionHash,
      csrfHash: input.csrfHash,
      now: Date.now(),
      resolveId: input.resolveId,
      candidateId: input.candidateId,
      reservationId,
      outcome: 'release',
    });
  } catch {
    // The reservation expires after 30 seconds if the best-effort release cannot be delivered.
  }
}

export async function settleResolvedMediaClaim(
  input: SettleResolvedMediaClaimInput,
): Promise<void> {
  const response = await internalPost(input.sessions, input.identity, '/resolve-vault/settle', {
    sessionHash: input.identity.sessionHash,
    csrfHash: input.csrfHash,
    now: input.now ?? Date.now(),
    resolveId: input.resolveId,
    candidateId: input.candidateId,
    reservationId: input.reservationId,
    outcome: input.outcome,
  });
  if (response.status !== 200) {
    return mapStatus(response.status);
  }
  const body = await readJson(response);
  const record = decodeExactRecord(body, ['ok']);
  if (record === null || record['ok'] !== true) {
    return fail('RESOLVE_VAULT_UNAVAILABLE');
  }
}

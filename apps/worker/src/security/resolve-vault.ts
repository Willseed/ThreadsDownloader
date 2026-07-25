import { normalizeProbedMedia, type ProbedMedia } from '../resolver/media-probe.js';
import { decodeBase64Url } from '../utils/base64url.js';
import { createOpaqueId } from './cryptography.js';
import type { BrowserSessionIdentity, SessionNamespace } from './session-client.js';

export const RESOLVE_VAULT_MAX_BATCHES = 5;
export const RESOLVE_VAULT_MAX_CANDIDATES = 50;
export const RESOLVE_VAULT_MAX_BATCH_CANDIDATES = 10;
export const RESOLVE_VAULT_TTL_MS = 300_000;
export const RESOLVE_VAULT_STAGING_MS = 30_000;
export const RESOLVE_VAULT_RESERVATION_MS = 30_000;

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

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
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
  if (!isPlainObject(value) || !hasExactKeys(value, PROBED_MEDIA_WIRE_FIELDS)) {
    return null;
  }
  try {
    return normalizeProbedMedia(value);
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
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      'candidates',
      'csrfHash',
      'now',
      'permitId',
      'sessionHash',
      'shortcode',
    ]) ||
    !isSessionHash(value['sessionHash']) ||
    !isSessionHash(value['csrfHash']) ||
    !isPermitId(value['permitId']) ||
    !isSafeTimestamp(value['now']) ||
    typeof value['shortcode'] !== 'string' ||
    !SHORTCODE.test(value['shortcode']) ||
    !Array.isArray(value['candidates']) ||
    value['candidates'].length < 1 ||
    value['candidates'].length > RESOLVE_VAULT_MAX_BATCH_CANDIDATES
  ) {
    return null;
  }
  const candidates: ProbedMedia[] = [];
  for (const candidate of value['candidates']) {
    const decoded = decodeProbedMediaWire(candidate);
    if (decoded === null) {
      return null;
    }
    candidates.push(decoded);
  }
  return {
    sessionHash: value['sessionHash'],
    csrfHash: value['csrfHash'],
    permitId: value['permitId'],
    now: value['now'],
    shortcode: value['shortcode'],
    candidates,
  };
}

export function decodeResolveVaultClaimRequest(value: unknown): ResolveVaultClaimRequest | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      'candidateId',
      'csrfHash',
      'now',
      'reservationId',
      'resolveId',
      'sessionHash',
    ]) ||
    !isSessionHash(value['sessionHash']) ||
    !isSessionHash(value['csrfHash']) ||
    !isSafeTimestamp(value['now']) ||
    !isOpaqueId(value['resolveId']) ||
    !isOpaqueId(value['candidateId']) ||
    !isOpaqueId(value['reservationId'])
  ) {
    return null;
  }
  return {
    sessionHash: value['sessionHash'],
    csrfHash: value['csrfHash'],
    now: value['now'],
    resolveId: value['resolveId'],
    candidateId: value['candidateId'],
    reservationId: value['reservationId'],
  };
}

export function decodeResolveVaultSettleRequest(value: unknown): ResolveVaultSettleRequest | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      'candidateId',
      'csrfHash',
      'now',
      'outcome',
      'reservationId',
      'resolveId',
      'sessionHash',
    ])
  ) {
    return null;
  }
  const claim = decodeResolveVaultClaimRequest({
    sessionHash: value['sessionHash'],
    csrfHash: value['csrfHash'],
    now: value['now'],
    resolveId: value['resolveId'],
    candidateId: value['candidateId'],
    reservationId: value['reservationId'],
  });
  if (claim === null || (value['outcome'] !== 'consume' && value['outcome'] !== 'release')) {
    return null;
  }
  return { ...claim, outcome: value['outcome'] };
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
  try {
    const stub = sessions.get(sessions.idFromName(identity.rawId));
    return await stub.fetch(
      new Request(`https://session.internal${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  } catch {
    return fail('RESOLVE_VAULT_UNAVAILABLE');
  }
}

function decodeSafeCandidate(value: unknown): SafeResolvedMediaCandidate | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const hasLength = Object.hasOwn(value, 'contentLength');
  if (
    !hasExactKeys(
      value,
      hasLength ? ['candidateId', 'contentLength', 'filename'] : ['candidateId', 'filename'],
    ) ||
    !isOpaqueId(value['candidateId']) ||
    typeof value['filename'] !== 'string' ||
    !SAFE_FILENAME.test(value['filename']) ||
    (hasLength && !isContentLength(value['contentLength'])) ||
    value['contentLength'] === null
  ) {
    return null;
  }
  return hasLength
    ? {
        candidateId: value['candidateId'],
        filename: value['filename'],
        contentLength: value['contentLength'] as number,
      }
    : { candidateId: value['candidateId'], filename: value['filename'] };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return fail('RESOLVE_VAULT_UNAVAILABLE');
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
  if (
    !isPlainObject(body) ||
    !hasExactKeys(body, ['candidates', 'expiresAt', 'issuedAt', 'ok', 'resolveId']) ||
    body['ok'] !== true ||
    !isOpaqueId(body['resolveId']) ||
    !isBoundedServerDeadline(
      body['issuedAt'],
      body['expiresAt'],
      receivedAt,
      RESOLVE_VAULT_TTL_MS,
    ) ||
    !Array.isArray(body['candidates']) ||
    body['candidates'].length !== candidates.length
  ) {
    return fail('RESOLVE_VAULT_UNAVAILABLE');
  }
  const safeCandidates: SafeResolvedMediaCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of body['candidates']) {
    const decoded = decodeSafeCandidate(candidate);
    if (decoded === null || seen.has(decoded.candidateId)) {
      return fail('RESOLVE_VAULT_UNAVAILABLE');
    }
    seen.add(decoded.candidateId);
    safeCandidates.push(decoded);
  }
  return { resolveId: body['resolveId'], expiresAt: body['expiresAt'], candidates: safeCandidates };
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
    response = await internalPost(
      input.sessions,
      input.identity,
      '/resolve-vault/claim',
      requestBody,
    );
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
  if (
    !isPlainObject(body) ||
    !hasExactKeys(body, ['grant', 'ok', 'reservationExpiresAt', 'reservationId', 'reservedAt']) ||
    body['ok'] !== true ||
    body['reservationId'] !== reservationId ||
    !isBoundedServerDeadline(
      body['reservedAt'],
      body['reservationExpiresAt'],
      receivedAt,
      RESOLVE_VAULT_RESERVATION_MS,
    )
  ) {
    await bestEffortRelease(input, reservationId);
    return fail('RESOLVE_VAULT_UNAVAILABLE');
  }
  const media = decodeProbedMediaWire(body['grant']);
  if (media === null) {
    await bestEffortRelease(input, reservationId);
    return fail('RESOLVE_VAULT_UNAVAILABLE');
  }
  return { reservationId, reservationExpiresAt: body['reservationExpiresAt'], media };
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
  if (!isPlainObject(body) || !hasExactKeys(body, ['ok']) || body['ok'] !== true) {
    return fail('RESOLVE_VAULT_UNAVAILABLE');
  }
}

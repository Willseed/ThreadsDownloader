import { decodeExactRecord } from '@threads-downloader/contracts/strict-json';

import { normalizeProbedMedia, type ProbedMedia } from '../resolver/media-probe.js';
import { decodeBase64Url } from '../utils/base64url.js';
import type { AesGcmSealer } from './cryptography.js';

export const RESOLVED_MEDIA_GRANT_MAX_TTL_MS = 300_000;

const RESOLVED_MEDIA_GRANT_VERSION = 1;
const MAX_SEALED_GRANT_CHARACTERS = 8_192;
const MAX_FILENAME_CHARACTERS = 128;
const AAD_DOMAIN = 'threads-downloader:resolved-media-grant:v1';
const SAFE_FILENAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?$/u;
const SAFE_SHORTCODE = /^[A-Za-z0-9_-]{5,64}$/u;
const PAYLOAD_FIELDS = [
  'completionReliable',
  'contentLength',
  'contentType',
  'finalUrl',
  'lastModified',
  'probeMethod',
  'rangeCapability',
  'strongEtag',
  'v',
] as const;

export type ResolvedMediaGrantCodecErrorCode =
  'RESOLVED_MEDIA_GRANT_INVALID' | 'RESOLVED_MEDIA_GRANT_UNAVAILABLE';

export class ResolvedMediaGrantCodecError extends Error {
  constructor(readonly code: ResolvedMediaGrantCodecErrorCode) {
    super(code);
    this.name = 'ResolvedMediaGrantCodecError';
  }
}

export interface ResolvedMediaGrantBinding {
  readonly sessionHash: string;
  readonly resolveId: string;
  readonly candidateId: string;
  readonly ordinal: number;
  readonly filename: string;
  readonly shortcode: string;
  readonly contentLength: number | null;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface ResolvedMediaGrantCodec {
  seal(media: ProbedMedia, binding: ResolvedMediaGrantBinding, now: number): Promise<string>;
  open(sealedGrant: string, binding: ResolvedMediaGrantBinding, now: number): Promise<ProbedMedia>;
}

type NormalizedBinding = ResolvedMediaGrantBinding;

function fail(code: ResolvedMediaGrantCodecErrorCode): never {
  throw new ResolvedMediaGrantCodecError(code);
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

function isSafeTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isContentLength(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
}

function normalizeBinding(value: unknown): NormalizedBinding {
  const record = decodeExactRecord(value, [
    'candidateId',
    'contentLength',
    'expiresAt',
    'filename',
    'issuedAt',
    'ordinal',
    'resolveId',
    'sessionHash',
    'shortcode',
  ]);
  if (
    record === null ||
    !hasCanonicalBytes(record['sessionHash'], 43, 32) ||
    !hasCanonicalBytes(record['resolveId'], 32, 24) ||
    !hasCanonicalBytes(record['candidateId'], 32, 24) ||
    typeof record['ordinal'] !== 'number' ||
    !Number.isSafeInteger(record['ordinal']) ||
    record['ordinal'] < 1 ||
    record['ordinal'] > 10 ||
    typeof record['filename'] !== 'string' ||
    record['filename'].length > MAX_FILENAME_CHARACTERS ||
    !SAFE_FILENAME.test(record['filename']) ||
    typeof record['shortcode'] !== 'string' ||
    !SAFE_SHORTCODE.test(record['shortcode']) ||
    !isContentLength(record['contentLength']) ||
    !isSafeTimestamp(record['issuedAt']) ||
    !isSafeTimestamp(record['expiresAt']) ||
    record['expiresAt'] <= record['issuedAt'] ||
    record['expiresAt'] - record['issuedAt'] > RESOLVED_MEDIA_GRANT_MAX_TTL_MS
  ) {
    return fail('RESOLVED_MEDIA_GRANT_INVALID');
  }
  return {
    sessionHash: record['sessionHash'],
    resolveId: record['resolveId'],
    candidateId: record['candidateId'],
    ordinal: record['ordinal'],
    filename: record['filename'],
    shortcode: record['shortcode'],
    contentLength: record['contentLength'],
    issuedAt: record['issuedAt'],
    expiresAt: record['expiresAt'],
  };
}

function assertSealTime(binding: NormalizedBinding, now: number): void {
  if (!isSafeTimestamp(now) || binding.issuedAt !== now) {
    return fail('RESOLVED_MEDIA_GRANT_INVALID');
  }
}

function assertOpenTime(binding: NormalizedBinding, now: number): void {
  if (!isSafeTimestamp(now) || binding.issuedAt > now || now >= binding.expiresAt) {
    return fail('RESOLVED_MEDIA_GRANT_INVALID');
  }
}

function additionalAuthenticatedData(binding: NormalizedBinding): string {
  return [
    AAD_DOMAIN,
    binding.sessionHash,
    binding.resolveId,
    binding.candidateId,
    String(binding.ordinal),
    binding.filename,
    binding.shortcode,
    binding.contentLength === null ? 'null' : String(binding.contentLength),
    String(binding.issuedAt),
    String(binding.expiresAt),
  ].join(':');
}

function normalizeMedia(value: unknown): ProbedMedia {
  try {
    return normalizeProbedMedia(value);
  } catch {
    return fail('RESOLVED_MEDIA_GRANT_INVALID');
  }
}

function serializeMedia(media: ProbedMedia, binding: NormalizedBinding): string {
  const normalized = normalizeMedia(media);
  if (normalized.contentLength !== binding.contentLength) {
    return fail('RESOLVED_MEDIA_GRANT_INVALID');
  }
  const payload = JSON.stringify({
    v: RESOLVED_MEDIA_GRANT_VERSION,
    finalUrl: normalized.finalUrl.url.href,
    contentType: normalized.contentType,
    contentLength: normalized.contentLength,
    rangeCapability: normalized.rangeCapability,
    strongEtag: normalized.strongEtag,
    lastModified: normalized.lastModified,
    completionReliable: normalized.completionReliable,
    probeMethod: normalized.probeMethod,
  });
  return payload.length <= MAX_SEALED_GRANT_CHARACTERS
    ? payload
    : fail('RESOLVED_MEDIA_GRANT_INVALID');
}

function deserializeMedia(plaintext: string): ProbedMedia {
  if (plaintext.length > MAX_SEALED_GRANT_CHARACTERS) {
    return fail('RESOLVED_MEDIA_GRANT_INVALID');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(plaintext) as unknown;
  } catch {
    return fail('RESOLVED_MEDIA_GRANT_INVALID');
  }
  const record = decodeExactRecord(payload, PAYLOAD_FIELDS);
  if (record === null || record['v'] !== RESOLVED_MEDIA_GRANT_VERSION) {
    return fail('RESOLVED_MEDIA_GRANT_INVALID');
  }
  return normalizeMedia({
    finalUrl: record['finalUrl'],
    contentType: record['contentType'],
    contentLength: record['contentLength'],
    rangeCapability: record['rangeCapability'],
    strongEtag: record['strongEtag'],
    lastModified: record['lastModified'],
    completionReliable: record['completionReliable'],
    probeMethod: record['probeMethod'],
  });
}

export function createResolvedMediaGrantCodec(sealer: AesGcmSealer): ResolvedMediaGrantCodec {
  return {
    async seal(
      media: ProbedMedia,
      rawBinding: ResolvedMediaGrantBinding,
      now: number,
    ): Promise<string> {
      let binding: NormalizedBinding;
      let plaintext: string;
      try {
        binding = normalizeBinding(rawBinding);
        assertSealTime(binding, now);
        plaintext = serializeMedia(media, binding);
      } catch (error: unknown) {
        if (error instanceof ResolvedMediaGrantCodecError) {
          throw error;
        }
        return fail('RESOLVED_MEDIA_GRANT_INVALID');
      }

      try {
        const sealed = await sealer.seal(plaintext, additionalAuthenticatedData(binding));
        return typeof sealed === 'string' &&
          sealed.length > 0 &&
          sealed.length <= MAX_SEALED_GRANT_CHARACTERS
          ? sealed
          : fail('RESOLVED_MEDIA_GRANT_UNAVAILABLE');
      } catch (error: unknown) {
        if (error instanceof ResolvedMediaGrantCodecError) {
          throw error;
        }
        return fail('RESOLVED_MEDIA_GRANT_UNAVAILABLE');
      }
    },

    async open(
      sealedGrant: string,
      rawBinding: ResolvedMediaGrantBinding,
      now: number,
    ): Promise<ProbedMedia> {
      let binding: NormalizedBinding;
      try {
        binding = normalizeBinding(rawBinding);
        assertOpenTime(binding, now);
      } catch (error: unknown) {
        if (error instanceof ResolvedMediaGrantCodecError) {
          throw error;
        }
        return fail('RESOLVED_MEDIA_GRANT_INVALID');
      }
      if (
        typeof sealedGrant !== 'string' ||
        sealedGrant.length === 0 ||
        sealedGrant.length > MAX_SEALED_GRANT_CHARACTERS
      ) {
        return fail('RESOLVED_MEDIA_GRANT_INVALID');
      }

      let plaintext: string;
      try {
        plaintext = await sealer.open(sealedGrant, additionalAuthenticatedData(binding));
      } catch {
        return fail('RESOLVED_MEDIA_GRANT_INVALID');
      }
      try {
        const media = deserializeMedia(plaintext);
        return media.contentLength === binding.contentLength
          ? media
          : fail('RESOLVED_MEDIA_GRANT_INVALID');
      } catch (error: unknown) {
        if (error instanceof ResolvedMediaGrantCodecError) {
          throw error;
        }
        return fail('RESOLVED_MEDIA_GRANT_INVALID');
      }
    },
  };
}

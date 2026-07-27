import { decodeExactRecord } from '@threads-downloader/contracts/strict-json';

import type { ProbedMedia } from '../resolver/media-probe.js';
import { decodeBase64Url, isCanonicalBase64UrlWithExactBytes } from '../utils/base64url.js';
import { createAesGcmSealer, type AesGcmSealer } from './cryptography.js';
import { parseCdnUrl, type CdnUrl } from './upstream-policy.js';

export const PREVIEW_CAPABILITY_TTL_MS = 1_200_000;
export const MAX_PREVIEW_CAPABILITY_CHARACTERS = 8_192;

const PREVIEW_CAPABILITY_VERSION = 1;
const KEY_BYTES = 32;
const SESSION_HASH_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_PLAINTEXT_CHARACTERS = 4_608;
const AAD_DOMAIN = 'threads-downloader:preview-capability:v1';

export type PreviewCapabilityErrorCode =
  'PREVIEW_CAPABILITY_EXPIRED' | 'PREVIEW_CAPABILITY_INVALID' | 'PREVIEW_CAPABILITY_UNAVAILABLE';

export class PreviewCapabilityError extends Error {
  constructor(readonly code: PreviewCapabilityErrorCode) {
    super(code);
    this.name = 'PreviewCapabilityError';
  }
}

export interface IssuedPreviewCapability {
  readonly capability: string;
  readonly expiresAt: number;
}

export interface PreviewCapabilityCodec {
  seal(media: ProbedMedia, sessionHash: string, now: number): Promise<IssuedPreviewCapability>;
  open(capability: string, sessionHash: string, now: number): Promise<CdnUrl>;
}

function fail(code: PreviewCapabilityErrorCode): never {
  throw new PreviewCapabilityError(code);
}

function isSafeTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isCanonicalPreviewCapability(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_PREVIEW_CAPABILITY_CHARACTERS
  ) {
    return false;
  }
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') {
    return false;
  }
  try {
    return (
      decodeBase64Url(parts[1] ?? '').byteLength === IV_BYTES &&
      decodeBase64Url(parts[2] ?? '').byteLength >= TAG_BYTES
    );
  } catch {
    return false;
  }
}

async function importPreviewKey(encodedKey: string): Promise<CryptoKey> {
  let material: Uint8Array<ArrayBuffer> | null = null;
  try {
    if (typeof encodedKey !== 'string' || encodedKey.length !== 43) {
      return fail('PREVIEW_CAPABILITY_UNAVAILABLE');
    }
    material = decodeBase64Url(encodedKey);
    if (material.byteLength !== KEY_BYTES) {
      return fail('PREVIEW_CAPABILITY_UNAVAILABLE');
    }
    return await crypto.subtle.importKey('raw', material, { name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
  } catch (error: unknown) {
    if (error instanceof PreviewCapabilityError) {
      throw error;
    }
    return fail('PREVIEW_CAPABILITY_UNAVAILABLE');
  } finally {
    material?.fill(0);
  }
}

function safeTarget(media: ProbedMedia): string {
  try {
    const target = parseCdnUrl(media.finalUrl.url.href);
    return target.url.href === media.finalUrl.url.href
      ? target.url.href
      : fail('PREVIEW_CAPABILITY_INVALID');
  } catch (error: unknown) {
    if (error instanceof PreviewCapabilityError) {
      throw error;
    }
    return fail('PREVIEW_CAPABILITY_INVALID');
  }
}

function serializePayload(
  media: ProbedMedia,
  sessionHash: string,
  issuedAt: number,
  expiresAt: number,
): string {
  if (
    !isCanonicalBase64UrlWithExactBytes(sessionHash, SESSION_HASH_BYTES) ||
    !isSafeTimestamp(issuedAt) ||
    expiresAt !== issuedAt + PREVIEW_CAPABILITY_TTL_MS
  ) {
    return fail('PREVIEW_CAPABILITY_INVALID');
  }
  const plaintext = JSON.stringify({
    v: PREVIEW_CAPABILITY_VERSION,
    sessionHash,
    target: safeTarget(media),
    issuedAt,
    expiresAt,
  });
  return plaintext.length <= MAX_PLAINTEXT_CHARACTERS
    ? plaintext
    : fail('PREVIEW_CAPABILITY_INVALID');
}

function deserializePayload(plaintext: string, expectedSessionHash: string, now: number): CdnUrl {
  if (
    plaintext.length === 0 ||
    plaintext.length > MAX_PLAINTEXT_CHARACTERS ||
    !isCanonicalBase64UrlWithExactBytes(expectedSessionHash, SESSION_HASH_BYTES) ||
    !isSafeTimestamp(now)
  ) {
    return fail('PREVIEW_CAPABILITY_INVALID');
  }
  let value: unknown;
  try {
    value = JSON.parse(plaintext) as unknown;
  } catch {
    return fail('PREVIEW_CAPABILITY_INVALID');
  }
  const record = decodeExactRecord(value, ['expiresAt', 'issuedAt', 'sessionHash', 'target', 'v']);
  if (
    record === null ||
    record['v'] !== PREVIEW_CAPABILITY_VERSION ||
    record['sessionHash'] !== expectedSessionHash ||
    !isSafeTimestamp(record['issuedAt']) ||
    !isSafeTimestamp(record['expiresAt']) ||
    record['expiresAt'] !== record['issuedAt'] + PREVIEW_CAPABILITY_TTL_MS ||
    record['issuedAt'] > now
  ) {
    return fail('PREVIEW_CAPABILITY_INVALID');
  }
  if (now >= record['expiresAt']) {
    return fail('PREVIEW_CAPABILITY_EXPIRED');
  }
  if (typeof record['target'] !== 'string') {
    return fail('PREVIEW_CAPABILITY_INVALID');
  }
  try {
    const target = parseCdnUrl(record['target']);
    return target.url.href === record['target'] ? target : fail('PREVIEW_CAPABILITY_INVALID');
  } catch (error: unknown) {
    if (error instanceof PreviewCapabilityError) {
      throw error;
    }
    return fail('PREVIEW_CAPABILITY_INVALID');
  }
}

export async function createPreviewCapabilityCodec(
  encryptionKey: string,
): Promise<PreviewCapabilityCodec> {
  const sealer: AesGcmSealer = createAesGcmSealer(await importPreviewKey(encryptionKey));
  return {
    async seal(media, sessionHash, now) {
      if (!isSafeTimestamp(now) || now > Number.MAX_SAFE_INTEGER - PREVIEW_CAPABILITY_TTL_MS) {
        return fail('PREVIEW_CAPABILITY_INVALID');
      }
      const expiresAt = now + PREVIEW_CAPABILITY_TTL_MS;
      let capability: string;
      try {
        capability = await sealer.seal(
          serializePayload(media, sessionHash, now, expiresAt),
          AAD_DOMAIN,
        );
      } catch (error: unknown) {
        if (error instanceof PreviewCapabilityError) {
          throw error;
        }
        return fail('PREVIEW_CAPABILITY_UNAVAILABLE');
      }
      return isCanonicalPreviewCapability(capability)
        ? { capability, expiresAt }
        : fail('PREVIEW_CAPABILITY_UNAVAILABLE');
    },

    async open(capability, sessionHash, now) {
      if (!isCanonicalPreviewCapability(capability)) {
        return fail('PREVIEW_CAPABILITY_INVALID');
      }
      let plaintext: string;
      try {
        plaintext = await sealer.open(capability, AAD_DOMAIN);
      } catch {
        return fail('PREVIEW_CAPABILITY_INVALID');
      }
      return deserializePayload(plaintext, sessionHash, now);
    },
  };
}

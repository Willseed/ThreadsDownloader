import type { ProbedMedia } from '../resolver/media-probe.js';
import { decodeBase64Url, encodeBase64Url } from '../utils/base64url.js';
import { decodeProbedMediaWire, encodeProbedMediaWire } from './resolve-vault.js';

export const DOWNLOAD_MEDIA_MAX_TTL_MS = 3_600_000;

const DOWNLOAD_MEDIA_VERSION = 1;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_PLAINTEXT_CHARACTERS = 8_192;
const MAX_ENVELOPE_CHARACTERS = 12_000;
const MAX_FILENAME_CHARACTERS = 128;
const AAD_DOMAIN = 'threads-downloader:download-media:v1';
const SAFE_FILENAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?$/u;
const SAFE_SHORTCODE = /^[A-Za-z0-9_-]{5,64}$/u;

export type DownloadMediaCodecErrorCode = 'DOWNLOAD_MEDIA_INVALID' | 'DOWNLOAD_MEDIA_UNAVAILABLE';

export class DownloadMediaCodecError extends Error {
  constructor(readonly code: DownloadMediaCodecErrorCode) {
    super(code);
    this.name = 'DownloadMediaCodecError';
  }
}

export interface DownloadMediaBinding {
  readonly sessionHash: string;
  readonly downloadId: string;
  readonly filename: string;
  readonly shortcode: string;
  readonly issuedAt: number;
  readonly absoluteExpiresAt: number;
}

export interface DownloadMediaCodec {
  seal(media: ProbedMedia, binding: DownloadMediaBinding, now: number): Promise<string>;
  open(sealedMedia: string, binding: DownloadMediaBinding, now: number): Promise<ProbedMedia>;
}

interface DownloadMediaEnvelope {
  readonly v: 1;
  readonly iv: string;
  readonly ciphertext: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function fail(code: DownloadMediaCodecErrorCode): never {
  throw new DownloadMediaCodecError(code);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right, 'en'));
  const sortedExpected = [...expected].sort((left, right) => left.localeCompare(right, 'en'));
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function hasCanonicalBytes(
  value: unknown,
  minimumBytes: number,
  exactBytes?: number,
): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    const length = decodeBase64Url(value).byteLength;
    return exactBytes === undefined ? length >= minimumBytes : length === exactBytes;
  } catch {
    return false;
  }
}

function isSafeTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function normalizeBinding(value: unknown): DownloadMediaBinding {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      'absoluteExpiresAt',
      'downloadId',
      'filename',
      'issuedAt',
      'sessionHash',
      'shortcode',
    ]) ||
    !hasCanonicalBytes(value['sessionHash'], KEY_BYTES, KEY_BYTES) ||
    !hasCanonicalBytes(value['downloadId'], 16) ||
    typeof value['filename'] !== 'string' ||
    value['filename'].length > MAX_FILENAME_CHARACTERS ||
    !SAFE_FILENAME.test(value['filename']) ||
    typeof value['shortcode'] !== 'string' ||
    !SAFE_SHORTCODE.test(value['shortcode']) ||
    !isSafeTimestamp(value['issuedAt']) ||
    !isSafeTimestamp(value['absoluteExpiresAt']) ||
    value['absoluteExpiresAt'] <= value['issuedAt'] ||
    value['absoluteExpiresAt'] - value['issuedAt'] > DOWNLOAD_MEDIA_MAX_TTL_MS
  ) {
    return fail('DOWNLOAD_MEDIA_INVALID');
  }
  return {
    sessionHash: value['sessionHash'],
    downloadId: value['downloadId'],
    filename: value['filename'],
    shortcode: value['shortcode'],
    issuedAt: value['issuedAt'],
    absoluteExpiresAt: value['absoluteExpiresAt'],
  };
}

function assertSealTime(binding: DownloadMediaBinding, now: number): void {
  if (!isSafeTimestamp(now) || binding.issuedAt !== now || now >= binding.absoluteExpiresAt) {
    return fail('DOWNLOAD_MEDIA_INVALID');
  }
}

function assertOpenTime(binding: DownloadMediaBinding, now: number): void {
  if (!isSafeTimestamp(now) || binding.issuedAt > now || now >= binding.absoluteExpiresAt) {
    return fail('DOWNLOAD_MEDIA_INVALID');
  }
}

function additionalAuthenticatedData(binding: DownloadMediaBinding): Uint8Array<ArrayBuffer> {
  return encoder.encode(
    JSON.stringify({
      domain: AAD_DOMAIN,
      sessionHash: binding.sessionHash,
      downloadId: binding.downloadId,
      filename: binding.filename,
      shortcode: binding.shortcode,
      issuedAt: binding.issuedAt,
      absoluteExpiresAt: binding.absoluteExpiresAt,
    }),
  );
}

function serializeMedia(media: ProbedMedia): string {
  let plaintext: string;
  try {
    plaintext = JSON.stringify(encodeProbedMediaWire(media));
  } catch {
    return fail('DOWNLOAD_MEDIA_INVALID');
  }
  return plaintext.length <= MAX_PLAINTEXT_CHARACTERS ? plaintext : fail('DOWNLOAD_MEDIA_INVALID');
}

function deserializeMedia(plaintext: string): ProbedMedia {
  if (plaintext.length > MAX_PLAINTEXT_CHARACTERS) {
    return fail('DOWNLOAD_MEDIA_INVALID');
  }
  let value: unknown;
  try {
    value = JSON.parse(plaintext) as unknown;
  } catch {
    return fail('DOWNLOAD_MEDIA_INVALID');
  }
  const media = decodeProbedMediaWire(value);
  if (media === null) {
    return fail('DOWNLOAD_MEDIA_INVALID');
  }
  try {
    return JSON.stringify(encodeProbedMediaWire(media)) === plaintext
      ? media
      : fail('DOWNLOAD_MEDIA_INVALID');
  } catch {
    return fail('DOWNLOAD_MEDIA_INVALID');
  }
}

function serializeEnvelope(iv: Uint8Array, ciphertext: ArrayBuffer): string {
  const value: DownloadMediaEnvelope = {
    v: DOWNLOAD_MEDIA_VERSION,
    iv: encodeBase64Url(iv),
    ciphertext: encodeBase64Url(ciphertext),
  };
  const envelope = JSON.stringify(value);
  return envelope.length <= MAX_ENVELOPE_CHARACTERS ? envelope : fail('DOWNLOAD_MEDIA_UNAVAILABLE');
}

function deserializeEnvelope(sealedMedia: string): {
  readonly iv: Uint8Array<ArrayBuffer>;
  readonly ciphertext: Uint8Array<ArrayBuffer>;
} {
  if (
    typeof sealedMedia !== 'string' ||
    sealedMedia.length === 0 ||
    sealedMedia.length > MAX_ENVELOPE_CHARACTERS
  ) {
    return fail('DOWNLOAD_MEDIA_INVALID');
  }
  let value: unknown;
  try {
    value = JSON.parse(sealedMedia) as unknown;
  } catch {
    return fail('DOWNLOAD_MEDIA_INVALID');
  }
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ['ciphertext', 'iv', 'v']) ||
    value['v'] !== DOWNLOAD_MEDIA_VERSION ||
    !hasCanonicalBytes(value['iv'], IV_BYTES, IV_BYTES) ||
    !hasCanonicalBytes(value['ciphertext'], TAG_BYTES) ||
    JSON.stringify({
      v: value['v'],
      iv: value['iv'],
      ciphertext: value['ciphertext'],
    }) !== sealedMedia
  ) {
    return fail('DOWNLOAD_MEDIA_INVALID');
  }
  return {
    iv: decodeBase64Url(value['iv']),
    ciphertext: decodeBase64Url(value['ciphertext']),
  };
}

async function importDownloadEncryptionKey(encodedKey: string): Promise<CryptoKey> {
  let material: Uint8Array<ArrayBuffer> | null = null;
  try {
    if (typeof encodedKey !== 'string' || encodedKey.length !== 43) {
      return fail('DOWNLOAD_MEDIA_UNAVAILABLE');
    }
    material = decodeBase64Url(encodedKey);
    if (material.byteLength !== KEY_BYTES) {
      return fail('DOWNLOAD_MEDIA_UNAVAILABLE');
    }
    return await crypto.subtle.importKey('raw', material, { name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
  } catch (error: unknown) {
    if (error instanceof DownloadMediaCodecError) {
      throw error;
    }
    return fail('DOWNLOAD_MEDIA_UNAVAILABLE');
  } finally {
    material?.fill(0);
  }
}

export async function createDownloadMediaCodec(
  downloadEncryptionKey: string,
): Promise<DownloadMediaCodec> {
  const key = await importDownloadEncryptionKey(downloadEncryptionKey);
  return {
    async seal(media, rawBinding, now): Promise<string> {
      let binding: DownloadMediaBinding;
      let plaintext: Uint8Array<ArrayBuffer>;
      let aad: Uint8Array<ArrayBuffer>;
      try {
        binding = normalizeBinding(rawBinding);
        assertSealTime(binding, now);
        plaintext = encoder.encode(serializeMedia(media));
        aad = additionalAuthenticatedData(binding);
      } catch (error: unknown) {
        if (error instanceof DownloadMediaCodecError) {
          throw error;
        }
        return fail('DOWNLOAD_MEDIA_INVALID');
      }

      try {
        const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
        const ciphertext = await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv, additionalData: aad, tagLength: TAG_BYTES * 8 },
          key,
          plaintext,
        );
        return serializeEnvelope(iv, ciphertext);
      } catch (error: unknown) {
        if (error instanceof DownloadMediaCodecError) {
          throw error;
        }
        return fail('DOWNLOAD_MEDIA_UNAVAILABLE');
      } finally {
        plaintext.fill(0);
        aad.fill(0);
      }
    },

    async open(sealedMedia, rawBinding, now): Promise<ProbedMedia> {
      let binding: DownloadMediaBinding;
      let envelope: ReturnType<typeof deserializeEnvelope>;
      try {
        binding = normalizeBinding(rawBinding);
        assertOpenTime(binding, now);
        envelope = deserializeEnvelope(sealedMedia);
      } catch (error: unknown) {
        if (error instanceof DownloadMediaCodecError) {
          throw error;
        }
        return fail('DOWNLOAD_MEDIA_INVALID');
      }

      let aad: Uint8Array<ArrayBuffer> | null = null;
      let plaintext: Uint8Array<ArrayBuffer> | null = null;
      try {
        aad = additionalAuthenticatedData(binding);
        plaintext = new Uint8Array(
          await crypto.subtle.decrypt(
            {
              name: 'AES-GCM',
              iv: envelope.iv,
              additionalData: aad,
              tagLength: TAG_BYTES * 8,
            },
            key,
            envelope.ciphertext,
          ),
        );
        return deserializeMedia(decoder.decode(plaintext));
      } catch {
        return fail('DOWNLOAD_MEDIA_INVALID');
      } finally {
        aad?.fill(0);
        plaintext?.fill(0);
      }
    },
  };
}

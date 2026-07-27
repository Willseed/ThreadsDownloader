import { describe, expect, it, vi } from 'vitest';

import type { ProbedMedia } from '../src/resolver/media-probe.js';
import { createAesGcmSealer, importEncryptionKey } from '../src/security/cryptography.js';
import {
  createDownloadMediaCodec,
  DOWNLOAD_MEDIA_MAX_TTL_MS,
  DownloadMediaCodecError,
  type DownloadMediaBinding,
  type DownloadMediaCodecErrorCode,
} from '../src/security/download-media-codec.js';
import {
  createResolvedMediaGrantCodec,
  type ResolvedMediaGrantBinding,
} from '../src/security/resolved-media-grant.js';
import { parseCdnUrl } from '../src/security/upstream-policy.js';
import { decodeBase64Url, encodeBase64Url } from '../src/utils/base64url.js';

const NOW = 1_000_000;
const LAST_MODIFIED = 'Mon, 01 Jan 2024 00:00:00 GMT';
const PRIVATE_URL =
  'https://video.cdninstagram.com/media/private.mp4?token=private-download-target';

function bytes(length: number, offset = 0): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index + offset) % 256);
}

function encodeBase64(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

const firstKey = encodeBase64Url(bytes(32, 33));
const secondKey = encodeBase64Url(bytes(32, 71));
const sessionHash = encodeBase64Url(bytes(32, 11));
const otherSessionHash = encodeBase64Url(bytes(32, 12));
const downloadId = encodeBase64Url(bytes(16, 21));
const otherDownloadId = encodeBase64Url(bytes(24, 22));

function binding(overrides: Partial<DownloadMediaBinding> = {}): DownloadMediaBinding {
  return {
    sessionHash,
    downloadId,
    filename: 'threads_Abcde_1.mp4',
    shortcode: 'Abcde_1',
    issuedAt: NOW,
    absoluteExpiresAt: NOW + DOWNLOAD_MEDIA_MAX_TTL_MS,
    ...overrides,
  };
}

function media(overrides: Partial<ProbedMedia> = {}): ProbedMedia {
  return {
    finalUrl: parseCdnUrl(PRIVATE_URL),
    contentType: 'video/mp4',
    contentLength: 42,
    rangeCapability: 'bytes',
    strongEtag: '"download-v1"',
    lastModified: LAST_MODIFIED,
    validator: { kind: 'etag', value: '"download-v1"' },
    completionReliable: true,
    probeMethod: 'head',
    ...overrides,
  };
}

async function expectCodecError(
  action: Promise<unknown>,
  code: DownloadMediaCodecErrorCode,
  secrets: readonly string[] = [],
): Promise<void> {
  let caught: unknown;
  try {
    await action;
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DownloadMediaCodecError);
  expect(caught).toMatchObject({ code, message: code });
  for (const secret of secrets) {
    if (secret !== '') {
      expect((caught as Error).message).not.toContain(secret);
    }
  }
}

interface TestEnvelope {
  readonly v: number;
  readonly iv: string;
  readonly ciphertext: string;
}

function parseEnvelope(value: string): TestEnvelope {
  return JSON.parse(value) as TestEnvelope;
}

function mediaPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    finalUrl: PRIVATE_URL,
    contentType: 'video/mp4',
    contentLength: 42,
    rangeCapability: 'bytes',
    strongEtag: '"download-v1"',
    lastModified: LAST_MODIFIED,
    completionReliable: true,
    probeMethod: 'head',
    ...overrides,
  };
}

function withoutField(value: Record<string, unknown>, field: string): Record<string, unknown> {
  const copy = { ...value };
  delete copy[field];
  return copy;
}

function aad(value: DownloadMediaBinding): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    JSON.stringify({
      domain: 'threads-downloader:download-media:v1',
      sessionHash: value.sessionHash,
      downloadId: value.downloadId,
      filename: value.filename,
      shortcode: value.shortcode,
      issuedAt: value.issuedAt,
      absoluteExpiresAt: value.absoluteExpiresAt,
    }),
  );
}

async function importTestKey(encodedKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    decodeBase64Url(encodedKey),
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function sealPlaintext(
  plaintext: string,
  targetBinding = binding(),
  encodedKey = firstKey,
): Promise<string> {
  const iv = new Uint8Array(12);
  iv.set(bytes(12, 101));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(targetBinding), tagLength: 128 },
    await importTestKey(encodedKey),
    new TextEncoder().encode(plaintext),
  );
  return JSON.stringify({ v: 1, iv: encodeBase64Url(iv), ciphertext: encodeBase64Url(ciphertext) });
}

function sealPayload(
  payload: unknown,
  targetBinding = binding(),
  encodedKey = firstKey,
): Promise<string> {
  return sealPlaintext(JSON.stringify(payload), targetBinding, encodedKey);
}

function alterBase64Url(value: string, byteIndex: number): string {
  const decoded = decodeBase64Url(value);
  decoded[byteIndex] = (decoded[byteIndex] ?? 0) ^ 1;
  return encodeBase64Url(decoded);
}

function legacyBinding(): ResolvedMediaGrantBinding {
  return {
    sessionHash,
    resolveId: encodeBase64Url(bytes(24, 31)),
    candidateId: encodeBase64Url(bytes(24, 41)),
    ordinal: 1,
    filename: 'threads_Abcde_1.mp4',
    shortcode: 'Abcde_1',
    contentLength: 42,
    issuedAt: NOW,
    expiresAt: NOW + 300_000,
  };
}

describe('DownloadMediaCodec round trips', () => {
  it.each([
    ['minimum-length', downloadId],
    ['longer', otherDownloadId],
  ])(
    'round-trips a strict target with a %s download ID for exactly one hour',
    async (_case, id) => {
      const subject = await createDownloadMediaCodec(firstKey);
      const target = media();
      const targetBinding = binding({ downloadId: id });
      const sealed = await subject.seal(target, targetBinding, NOW);

      await expect(subject.open(sealed, targetBinding, NOW)).resolves.toEqual(target);
      await expect(
        subject.open(sealed, targetBinding, targetBinding.absoluteExpiresAt - 1),
      ).resolves.toEqual(target);
      expect(sealed).not.toContain(PRIVATE_URL);
      expect(sealed).not.toContain('private-download-target');
    },
  );

  it('uses a fresh canonical 96-bit IV for every envelope', async () => {
    const subject = await createDownloadMediaCodec(firstKey);
    const first = parseEnvelope(await subject.seal(media(), binding(), NOW));
    const second = parseEnvelope(await subject.seal(media(), binding(), NOW));

    expect(Object.keys(first)).toEqual(['v', 'iv', 'ciphertext']);
    expect(first.v).toBe(1);
    expect(second.v).toBe(1);
    expect(decodeBase64Url(first.iv)).toHaveLength(12);
    expect(decodeBase64Url(second.iv)).toHaveLength(12);
    expect(decodeBase64Url(first.ciphertext).byteLength).toBeGreaterThan(16);
    expect(second.iv).not.toBe(first.iv);
    expect(second.ciphertext).not.toBe(first.ciphertext);
  });
});

describe('DownloadMediaCodec authenticated binding', () => {
  it.each([
    ['sessionHash', { sessionHash: otherSessionHash }],
    ['downloadId', { downloadId: otherDownloadId }],
    ['filename', { filename: 'threads_Abcde_2.mp4' }],
    ['shortcode', { shortcode: 'Other_2' }],
    ['issuedAt', { issuedAt: NOW - 1 }],
    ['absoluteExpiresAt', { absoluteExpiresAt: NOW + DOWNLOAD_MEDIA_MAX_TTL_MS - 1 }],
  ] satisfies ReadonlyArray<readonly [string, Partial<DownloadMediaBinding>]>)(
    'rejects a cross-context %s change',
    async (_field, override) => {
      const subject = await createDownloadMediaCodec(firstKey);
      const original = binding();
      const sealed = await subject.seal(media(), original, NOW);
      const changed = { ...original, ...override };

      await expectCodecError(subject.open(sealed, changed, NOW), 'DOWNLOAD_MEDIA_INVALID', [
        PRIVATE_URL,
        sealed,
        firstKey,
        changed.sessionHash,
        changed.downloadId,
      ]);
    },
  );
});

describe('DownloadMediaCodec time and binding policy', () => {
  it('rejects not-yet-valid and expired targets at the exact boundaries', async () => {
    const subject = await createDownloadMediaCodec(firstKey);
    const targetBinding = binding();
    const sealed = await subject.seal(media(), targetBinding, NOW);

    await expectCodecError(
      subject.open(sealed, targetBinding, targetBinding.issuedAt - 1),
      'DOWNLOAD_MEDIA_INVALID',
    );
    await expectCodecError(
      subject.open(sealed, targetBinding, targetBinding.absoluteExpiresAt),
      'DOWNLOAD_MEDIA_INVALID',
    );
  });

  it.each([
    ['zero lifetime', binding({ absoluteExpiresAt: NOW })],
    ['over one hour', binding({ absoluteExpiresAt: NOW + DOWNLOAD_MEDIA_MAX_TTL_MS + 1 })],
    ['negative issue time', binding({ issuedAt: -1 })],
    ['unsafe issue time', binding({ issuedAt: Number.MAX_SAFE_INTEGER + 1 })],
    ['unsafe absolute expiry', binding({ absoluteExpiresAt: Number.MAX_SAFE_INTEGER + 1 })],
  ])('rejects %s during seal and open', async (_case, invalidBinding) => {
    const subject = await createDownloadMediaCodec(firstKey);
    const sealed = await subject.seal(media(), binding(), NOW);

    await expectCodecError(
      subject.seal(media(), invalidBinding, invalidBinding.issuedAt),
      'DOWNLOAD_MEDIA_INVALID',
    );
    await expectCodecError(subject.open(sealed, invalidBinding, NOW), 'DOWNLOAD_MEDIA_INVALID');
  });

  it('requires seal time to equal the authenticated issue time', async () => {
    const subject = await createDownloadMediaCodec(firstKey);
    const sealed = await subject.seal(media(), binding(), NOW);
    await expectCodecError(subject.seal(media(), binding(), NOW + 1), 'DOWNLOAD_MEDIA_INVALID');
    await expectCodecError(
      subject.open(sealed, binding(), Number.MAX_SAFE_INTEGER + 1),
      'DOWNLOAD_MEDIA_INVALID',
    );
  });

  it.each([
    ['short session hash', binding({ sessionHash: encodeBase64Url(bytes(31)) })],
    ['long session hash', binding({ sessionHash: encodeBase64Url(bytes(33)) })],
    ['non-canonical session hash', binding({ sessionHash: `${sessionHash}=` })],
    ['short download ID', binding({ downloadId: encodeBase64Url(bytes(15)) })],
    ['non-canonical download ID', binding({ downloadId: `${downloadId}=` })],
    ['empty filename', binding({ filename: '' })],
    ['hidden filename', binding({ filename: '.private.mp4' })],
    ['path filename', binding({ filename: 'private/file.mp4' })],
    ['colon filename', binding({ filename: 'private:file.mp4' })],
    ['Unicode filename', binding({ filename: '私密.mp4' })],
    ['trailing dot filename', binding({ filename: 'private.' })],
    ['long filename', binding({ filename: `${'a'.repeat(125)}.mp4` })],
    ['short shortcode', binding({ shortcode: 'Abcd' })],
    ['path shortcode', binding({ shortcode: '../private' })],
    ['Unicode shortcode', binding({ shortcode: '私密短碼' })],
    [
      'extra binding field',
      { ...binding(), privateTarget: PRIVATE_URL } as unknown as DownloadMediaBinding,
    ],
    [
      'missing binding field',
      withoutField({ ...binding() }, 'filename') as unknown as DownloadMediaBinding,
    ],
  ])('rejects unsafe or non-exact binding: %s', async (_case, invalidBinding) => {
    const subject = await createDownloadMediaCodec(firstKey);
    const sealed = await subject.seal(media(), binding(), NOW);
    await expectCodecError(subject.seal(media(), invalidBinding, NOW), 'DOWNLOAD_MEDIA_INVALID', [
      PRIVATE_URL,
      firstKey,
      sessionHash,
      downloadId,
    ]);
    await expectCodecError(subject.open(sealed, invalidBinding, NOW), 'DOWNLOAD_MEDIA_INVALID', [
      PRIVATE_URL,
      sealed,
      firstKey,
      sessionHash,
      downloadId,
    ]);
  });
});

describe('DownloadMediaCodec strict envelope and cryptography', () => {
  it('rejects version, IV, ciphertext, and authentication-tag tampering', async () => {
    const subject = await createDownloadMediaCodec(firstKey);
    const sealed = await subject.seal(media(), binding(), NOW);
    const original = parseEnvelope(sealed);
    const ciphertextLength = decodeBase64Url(original.ciphertext).byteLength;
    const tampered = [
      JSON.stringify({ ...original, v: 2 }),
      JSON.stringify({ ...original, iv: alterBase64Url(original.iv, 0) }),
      JSON.stringify({ ...original, ciphertext: alterBase64Url(original.ciphertext, 0) }),
      JSON.stringify({
        ...original,
        ciphertext: alterBase64Url(original.ciphertext, ciphertextLength - 1),
      }),
    ];

    for (const value of tampered) {
      await expectCodecError(subject.open(value, binding(), NOW), 'DOWNLOAD_MEDIA_INVALID', [
        PRIVATE_URL,
        value,
        firstKey,
        sessionHash,
        downloadId,
      ]);
    }
  });

  it('rejects a wrong encryption key and resolved-grant ciphertext', async () => {
    const subject = await createDownloadMediaCodec(firstKey);
    const wrongKey = await createDownloadMediaCodec(secondKey);
    const sealed = await subject.seal(media(), binding(), NOW);
    await expectCodecError(wrongKey.open(sealed, binding(), NOW), 'DOWNLOAD_MEDIA_INVALID', [
      PRIVATE_URL,
      sealed,
      firstKey,
      secondKey,
    ]);

    const sharedRawBytes = bytes(32, 141);
    const legacy = createResolvedMediaGrantCodec(
      createAesGcmSealer(await importEncryptionKey(encodeBase64(sharedRawBytes))),
    );
    const legacySealed = await legacy.seal(media(), legacyBinding(), NOW);
    const download = await createDownloadMediaCodec(encodeBase64Url(sharedRawBytes));
    await expectCodecError(download.open(legacySealed, binding(), NOW), 'DOWNLOAD_MEDIA_INVALID', [
      legacySealed,
      PRIVATE_URL,
    ]);
  });

  it.each([
    '',
    'not-json',
    '{}',
    JSON.stringify({ v: 1, iv: encodeBase64Url(bytes(12)) }),
    JSON.stringify({ v: 1, ciphertext: encodeBase64Url(bytes(16)) }),
    JSON.stringify({
      iv: encodeBase64Url(bytes(12)),
      ciphertext: encodeBase64Url(bytes(16)),
    }),
    JSON.stringify({
      v: 1,
      iv: encodeBase64Url(bytes(12)),
      ciphertext: encodeBase64Url(bytes(16)),
      extra: 'private',
    }),
    JSON.stringify({
      v: 1,
      iv: `${encodeBase64Url(bytes(12))}=`,
      ciphertext: encodeBase64Url(bytes(16)),
    }),
    JSON.stringify({
      v: 1,
      iv: encodeBase64Url(bytes(11)),
      ciphertext: encodeBase64Url(bytes(16)),
    }),
    JSON.stringify({
      v: 1,
      iv: encodeBase64Url(bytes(12)),
      ciphertext: encodeBase64Url(bytes(15)),
    }),
    JSON.stringify({
      ciphertext: encodeBase64Url(bytes(16)),
      iv: encodeBase64Url(bytes(12)),
      v: 1,
    }),
    ' '.repeat(12_001),
  ])('rejects malformed or non-canonical envelope %#', async (value) => {
    const subject = await createDownloadMediaCodec(firstKey);
    await expectCodecError(subject.open(value, binding(), NOW), 'DOWNLOAD_MEDIA_INVALID', [
      value,
      PRIVATE_URL,
    ]);
  });

  it.each([encodeBase64Url(bytes(31)), `${firstKey}=`, encodeBase64(bytes(32)), 'not-base64url'])(
    'requires canonical base64url DOWNLOAD_ENCRYPTION_KEY material',
    async (invalidKey) => {
      await expectCodecError(createDownloadMediaCodec(invalidKey), 'DOWNLOAD_MEDIA_UNAVAILABLE', [
        invalidKey,
        PRIVATE_URL,
      ]);
    },
  );

  it('maps random source failures to a generic unavailable error', async () => {
    const secret = 'private random source and key detail';
    const subject = await createDownloadMediaCodec(firstKey);
    const random = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(() => {
      throw new Error(secret);
    });
    try {
      await expectCodecError(subject.seal(media(), binding(), NOW), 'DOWNLOAD_MEDIA_UNAVAILABLE', [
        secret,
        PRIVATE_URL,
        firstKey,
        sessionHash,
        downloadId,
      ]);
    } finally {
      random.mockRestore();
    }
  });
});

describe('DownloadMediaCodec strict media policy', () => {
  it('opens historical unversioned canonical plaintext but rejects reordered JSON', async () => {
    const subject = await createDownloadMediaCodec(firstKey);
    const canonicalPlaintext = JSON.stringify(mediaPayload());
    const canonical = await sealPlaintext(canonicalPlaintext);
    const reorderedPlaintext = JSON.stringify({
      probeMethod: 'head',
      completionReliable: true,
      lastModified: LAST_MODIFIED,
      strongEtag: '"download-v1"',
      rangeCapability: 'bytes',
      contentLength: 42,
      contentType: 'video/mp4',
      finalUrl: PRIVATE_URL,
    });
    const reordered = await sealPlaintext(reorderedPlaintext);

    expect(canonicalPlaintext).not.toBe(reorderedPlaintext);
    await expect(subject.open(canonical, binding(), NOW)).resolves.toEqual(media());
    await expectCodecError(subject.open(reordered, binding(), NOW), 'DOWNLOAD_MEDIA_INVALID', [
      PRIVATE_URL,
      reordered,
    ]);
  });

  it.each([
    ['extra field', { ...mediaPayload(), extra: 'private-media-field' }],
    ['missing field', withoutField(mediaPayload(), 'probeMethod')],
    ['non-canonical JSON', null],
  ])('rejects plaintext with %s', async (caseName, invalidPayload) => {
    const subject = await createDownloadMediaCodec(firstKey);
    const sealed =
      caseName === 'non-canonical JSON'
        ? await sealPlaintext(` ${JSON.stringify(mediaPayload())}`)
        : await sealPayload(invalidPayload);
    await expectCodecError(subject.open(sealed, binding(), NOW), 'DOWNLOAD_MEDIA_INVALID', [
      PRIVATE_URL,
      sealed,
      firstKey,
      sessionHash,
      downloadId,
    ]);
  });

  it.each([
    'https://attacker.example/media/private.mp4?token=private-download-target',
    'https://cdninstagram.com.attacker.example/media/private.mp4',
    'https://127.0.0.1/media/private.mp4',
    'https://video.cdninstagram.com:444/media/private.mp4',
    'https://video.cdninstagram.com@attacker.example/media/private.mp4',
    'https://VIDEO.CDNINSTAGRAM.COM:443/media/private.mp4',
  ])('rejects a malicious or non-canonical media URL: %s', async (url) => {
    const subject = await createDownloadMediaCodec(firstKey);
    const sealed = await sealPayload(mediaPayload({ finalUrl: url }));
    await expectCodecError(subject.open(sealed, binding(), NOW), 'DOWNLOAD_MEDIA_INVALID', [
      url,
      sealed,
      firstKey,
      sessionHash,
      downloadId,
    ]);
  });

  it('rejects a forged media target before encryption', async () => {
    const subject = await createDownloadMediaCodec(firstKey);
    const forged = {
      ...media(),
      finalUrl: { url: new URL('https://attacker.example/private.mp4?token=private') },
    } as unknown as ProbedMedia;
    await expectCodecError(subject.seal(forged, binding(), NOW), 'DOWNLOAD_MEDIA_INVALID', [
      forged.finalUrl.url.href,
      firstKey,
      sessionHash,
      downloadId,
    ]);
  });
});

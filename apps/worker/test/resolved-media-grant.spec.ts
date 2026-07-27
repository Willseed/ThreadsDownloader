import { describe, expect, it, vi } from 'vitest';

import {
  createAesGcmSealer,
  importEncryptionKey,
  type AesGcmSealer,
} from '../src/security/cryptography.js';
import {
  createResolvedMediaGrantCodec,
  RESOLVED_MEDIA_GRANT_MAX_TTL_MS,
  ResolvedMediaGrantCodecError,
  type ResolvedMediaGrantBinding,
  type ResolvedMediaGrantCodecErrorCode,
} from '../src/security/resolved-media-grant.js';
import type { ProbedMedia } from '../src/resolver/media-probe.js';
import { parseCdnUrl } from '../src/security/upstream-policy.js';
import { encodeBase64Url } from '../src/utils/base64url.js';

const NOW = 1_000_000;
const LAST_MODIFIED = 'Mon, 01 Jan 2024 00:00:00 GMT';
const PRIVATE_URL =
  'https://video.cdninstagram.com/media/private.mp4?token=private-resolved-target';

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

const firstKey = encodeBase64(bytes(32));
const secondKey = encodeBase64(bytes(32, 71));
const sessionHash = encodeBase64Url(bytes(32, 11));
const otherSessionHash = encodeBase64Url(bytes(32, 12));
const resolveId = encodeBase64Url(bytes(24, 21));
const otherResolveId = encodeBase64Url(bytes(24, 22));
const candidateId = encodeBase64Url(bytes(24, 31));
const otherCandidateId = encodeBase64Url(bytes(24, 32));

function binding(overrides: Partial<ResolvedMediaGrantBinding> = {}): ResolvedMediaGrantBinding {
  return {
    sessionHash,
    resolveId,
    candidateId,
    ordinal: 1,
    filename: 'threads-video-1.mp4',
    shortcode: 'Abcde_1',
    contentLength: 42,
    issuedAt: NOW,
    expiresAt: NOW + RESOLVED_MEDIA_GRANT_MAX_TTL_MS,
    ...overrides,
  };
}

function media(overrides: Partial<ProbedMedia> = {}): ProbedMedia {
  return {
    finalUrl: parseCdnUrl(PRIVATE_URL),
    contentType: 'video/mp4',
    contentLength: 42,
    rangeCapability: 'bytes',
    strongEtag: '"strong-v1"',
    lastModified: LAST_MODIFIED,
    validator: { kind: 'etag', value: '"strong-v1"' },
    completionReliable: true,
    probeMethod: 'head',
    ...overrides,
  };
}

async function codec(encodedKey = firstKey) {
  return createResolvedMediaGrantCodec(createAesGcmSealer(await importEncryptionKey(encodedKey)));
}

function aad(value: ResolvedMediaGrantBinding): string {
  return [
    'threads-downloader:resolved-media-grant:v1',
    value.sessionHash,
    value.resolveId,
    value.candidateId,
    String(value.ordinal),
    value.filename,
    value.shortcode,
    value.contentLength === null ? 'null' : String(value.contentLength),
    String(value.issuedAt),
    String(value.expiresAt),
  ].join(':');
}

function payload(value: ProbedMedia): Record<string, unknown> {
  return {
    v: 1,
    finalUrl: value.finalUrl.url.href,
    contentType: value.contentType,
    contentLength: value.contentLength,
    rangeCapability: value.rangeCapability,
    strongEtag: value.strongEtag,
    lastModified: value.lastModified,
    completionReliable: value.completionReliable,
    probeMethod: value.probeMethod,
  };
}

function withoutField(value: Record<string, unknown>, field: string): Record<string, unknown> {
  const copy = { ...value };
  delete copy[field];
  return copy;
}

async function sealPayload(
  value: unknown,
  grantBinding = binding(),
  encodedKey = firstKey,
): Promise<string> {
  const sealer = createAesGcmSealer(await importEncryptionKey(encodedKey));
  return sealer.seal(JSON.stringify(value), aad(grantBinding));
}

async function expectCodecError(
  action: Promise<unknown>,
  code: ResolvedMediaGrantCodecErrorCode,
  secrets: readonly string[] = [],
): Promise<void> {
  let caught: unknown;
  try {
    await action;
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ResolvedMediaGrantCodecError);
  expect(caught).toMatchObject({ code, message: code });
  for (const secret of secrets) {
    expect((caught as Error).message).not.toContain(secret);
  }
}

const authenticatedBindingMutations: ReadonlyArray<
  readonly [string, Partial<ResolvedMediaGrantBinding>]
> = [
  ['sessionHash', { sessionHash: otherSessionHash }],
  ['resolveId', { resolveId: otherResolveId }],
  ['candidateId', { candidateId: otherCandidateId }],
  ['ordinal', { ordinal: 2 }],
  ['filename', { filename: 'threads-video-other.mp4' }],
  ['shortcode', { shortcode: 'Other_2' }],
  ['contentLength', { contentLength: 43 }],
  ['issuedAt', { issuedAt: NOW - 1 }],
  ['expiresAt', { expiresAt: NOW + RESOLVED_MEDIA_GRANT_MAX_TTL_MS - 2 }],
];

describe('ResolvedMediaGrantCodec round trips', () => {
  it('round-trips every supported validator and length shape', async () => {
    const subject = await codec();
    const cases = [
      { media: media(), binding: binding() },
      {
        media: media({
          rangeCapability: 'none',
          strongEtag: null,
          validator: { kind: 'last-modified', value: LAST_MODIFIED },
          probeMethod: 'range-get',
        }),
        binding: binding({ filename: 'threads-video-2.webm', ordinal: 2 }),
      },
      {
        media: media({
          contentLength: null,
          rangeCapability: 'unknown',
          strongEtag: null,
          lastModified: null,
          validator: null,
          completionReliable: false,
        }),
        binding: binding({ contentLength: null, filename: 'threads-video-3.mp4', ordinal: 3 }),
      },
    ];

    for (const current of cases) {
      const sealed = await subject.seal(current.media, current.binding, NOW);
      await expect(subject.open(sealed, current.binding, NOW)).resolves.toEqual(current.media);
    }
  });

  it('uses a fresh IV and never exposes the CDN URL in ciphertext', async () => {
    const subject = await codec();
    const first = await subject.seal(media(), binding(), NOW);
    const second = await subject.seal(media(), binding(), NOW);

    expect(first).not.toBe(second);
    expect(first.startsWith('v1.')).toBe(true);
    expect(second.startsWith('v1.')).toBe(true);
    expect(first).not.toContain(PRIVATE_URL);
    expect(second).not.toContain(PRIVATE_URL);
  });
});

describe('ResolvedMediaGrantCodec authenticated binding', () => {
  it.each(authenticatedBindingMutations)(
    'rejects ciphertext when %s changes',
    async (_field, override) => {
      const original = binding({ expiresAt: NOW + RESOLVED_MEDIA_GRANT_MAX_TTL_MS - 1 });
      const changed = { ...original, ...override };
      const subject = await codec();
      const sealed = await subject.seal(media(), original, NOW);

      await expectCodecError(subject.open(sealed, changed, NOW), 'RESOLVED_MEDIA_GRANT_INVALID', [
        PRIVATE_URL,
        sealed,
        aad(changed),
      ]);
    },
  );

  it.each([
    ['short session hash', binding({ sessionHash: encodeBase64Url(bytes(31)) })],
    ['long session hash', binding({ sessionHash: encodeBase64Url(bytes(33)) })],
    ['short resolve id', binding({ resolveId: encodeBase64Url(bytes(23)) })],
    ['long resolve id', binding({ resolveId: encodeBase64Url(bytes(25)) })],
    ['short candidate id', binding({ candidateId: encodeBase64Url(bytes(23)) })],
    ['long candidate id', binding({ candidateId: encodeBase64Url(bytes(25)) })],
    ['zero ordinal', binding({ ordinal: 0 })],
    ['large ordinal', binding({ ordinal: 11 })],
    ['fractional ordinal', binding({ ordinal: 1.5 })],
    ['empty filename', binding({ filename: '' })],
    ['hidden filename', binding({ filename: '.private.mp4' })],
    ['path filename', binding({ filename: 'private/file.mp4' })],
    ['colon filename', binding({ filename: 'private:file.mp4' })],
    ['Unicode filename', binding({ filename: '私密.mp4' })],
    ['trailing dot filename', binding({ filename: 'private.' })],
    ['long filename', binding({ filename: `${'a'.repeat(125)}.mp4` })],
    ['unsafe shortcode', binding({ shortcode: '../private' })],
    ['zero public length', binding({ contentLength: 0 })],
    ['fractional public length', binding({ contentLength: 1.5 })],
  ])('rejects a non-canonical %s', async (_case, invalidBinding) => {
    const subject = await codec();
    await expectCodecError(
      subject.seal(media(), invalidBinding, NOW),
      'RESOLVED_MEDIA_GRANT_INVALID',
    );
  });

  it('requires public content length to exactly match the sealed media', async () => {
    const subject = await codec();
    await expectCodecError(
      subject.seal(media(), binding({ contentLength: null }), NOW),
      'RESOLVED_MEDIA_GRANT_INVALID',
    );

    const mismatchedPayload = await sealPayload(
      { ...payload(media()), contentLength: 43 },
      binding(),
    );
    await expectCodecError(
      subject.open(mismatchedPayload, binding(), NOW),
      'RESOLVED_MEDIA_GRANT_INVALID',
    );
  });
});

describe('ResolvedMediaGrantCodec time policy', () => {
  it('accepts a ten-minute grant at 599 seconds and rejects its exact expiry', async () => {
    const subject = await codec();
    const exact = binding({ expiresAt: NOW + RESOLVED_MEDIA_GRANT_MAX_TTL_MS });
    const sealed = await subject.seal(media(), exact, NOW);

    await expect(subject.open(sealed, exact, NOW)).resolves.toMatchObject({ contentLength: 42 });
    await expect(subject.open(sealed, exact, NOW + 599_000)).resolves.toMatchObject({
      contentLength: 42,
    });
    await expectCodecError(
      subject.open(sealed, exact, exact.expiresAt),
      'RESOLVED_MEDIA_GRANT_INVALID',
    );
    await expectCodecError(
      subject.open(sealed, exact, exact.issuedAt - 1),
      'RESOLVED_MEDIA_GRANT_INVALID',
    );
  });

  it.each([
    ['issuedAt differs from now', binding({ issuedAt: NOW - 1 }), NOW],
    ['zero lifetime', binding({ expiresAt: NOW }), NOW],
    ['over ten minutes', binding({ expiresAt: NOW + RESOLVED_MEDIA_GRANT_MAX_TTL_MS + 1 }), NOW],
    ['negative issuedAt', binding({ issuedAt: -1 }), -1],
    ['unsafe expiry', binding({ expiresAt: Number.MAX_SAFE_INTEGER + 1 }), NOW],
    ['unsafe now', binding(), Number.MAX_SAFE_INTEGER + 1],
  ])('rejects %s', async (_case, invalidBinding, issueNow) => {
    const subject = await codec();
    await expectCodecError(
      subject.seal(media(), invalidBinding, issueNow),
      'RESOLVED_MEDIA_GRANT_INVALID',
    );
  });
});

describe('ResolvedMediaGrantCodec media invariants', () => {
  it.each([
    ['unsafe URL', { finalUrl: { url: new URL('https://attacker.example/private') } }],
    ['non-canonical MIME', { contentType: 'Video/MP4' }],
    ['zero length', { contentLength: 0 }],
    ['unknown range GET', { probeMethod: 'range-get', rangeCapability: 'unknown' }],
    ['weak asserted ETag', { strongEtag: 'W/"weak"' }],
    ['invalid Last-Modified', { lastModified: 'private-date' }],
    ['validator drift', { validator: { kind: 'etag', value: '"other"' } }],
    ['completion drift', { completionReliable: false }],
    ['unknown probe method', { probeMethod: 'private-method' }],
    ['extra runtime field', { extra: 'private-extra-field' }],
  ])('rejects forged ProbedMedia with %s', async (_case, override) => {
    const subject = await codec();
    const forged = { ...media(), ...override } as unknown as ProbedMedia;
    await expectCodecError(subject.seal(forged, binding(), NOW), 'RESOLVED_MEDIA_GRANT_INVALID', [
      PRIVATE_URL,
      JSON.stringify(override),
    ]);
  });

  it.each([
    ['wrong version', { ...payload(media()), v: 2 }],
    ['extra validator', { ...payload(media()), validator: media().validator }],
    ['missing field', withoutField(payload(media()), 'probeMethod')],
    [
      'non-canonical URL',
      {
        ...payload(media()),
        finalUrl: 'https://VIDEO.CDNINSTAGRAM.COM:443/media/private.mp4',
      },
    ],
    ['non-canonical MIME', { ...payload(media()), contentType: ' video/mp4 ' }],
    ['invalid length', { ...payload(media()), contentLength: 0 }],
    ['weak ETag', { ...payload(media()), strongEtag: 'W/"weak"' }],
    ['invalid Last-Modified', { ...payload(media()), lastModified: 'private-date' }],
    ['invalid range capability', { ...payload(media()), rangeCapability: 'private-range' }],
    [
      'unknown range GET',
      { ...payload(media()), probeMethod: 'range-get', rangeCapability: 'unknown' },
    ],
    ['completion drift', { ...payload(media()), completionReliable: false }],
    ['invalid probe method', { ...payload(media()), probeMethod: 'private-method' }],
  ])('rejects strict payload with %s', async (_case, invalidPayload) => {
    const subject = await codec();
    const sealed = await sealPayload(invalidPayload);
    await expectCodecError(subject.open(sealed, binding(), NOW), 'RESOLVED_MEDIA_GRANT_INVALID', [
      PRIVATE_URL,
      JSON.stringify(invalidPayload),
    ]);
  });
});

describe('ResolvedMediaGrantCodec safe failures', () => {
  it('maps malformed, oversized, tampered, wrong-key, and invalid JSON input to INVALID', async () => {
    const subject = await codec();
    const sealed = await subject.seal(media(), binding(), NOW);
    const changedLast = sealed.endsWith('A') ? 'B' : 'A';
    const tampered = `${sealed.slice(0, -1)}${changedLast}`;
    const wrongKey = await codec(secondKey);
    const invalidJson = await createAesGcmSealer(await importEncryptionKey(firstKey)).seal(
      '{private malformed JSON',
      aad(binding()),
    );

    for (const [value, target] of [
      ['not-a-sealed-value', subject],
      ['A'.repeat(8_193), subject],
      [tampered, subject],
      [sealed, wrongKey],
      [invalidJson, subject],
    ] as const) {
      await expectCodecError(target.open(value, binding(), NOW), 'RESOLVED_MEDIA_GRANT_INVALID', [
        PRIVATE_URL,
        value,
      ]);
    }
  });

  it('maps seal failures to UNAVAILABLE without exposing adapter details', async () => {
    const secret = 'private seal failure and target detail';
    const sealer: AesGcmSealer = {
      seal: vi.fn(async () => {
        throw new Error(secret);
      }),
      open: vi.fn(async () => {
        throw new Error('unused');
      }),
    };
    const subject = createResolvedMediaGrantCodec(sealer);

    await expectCodecError(
      subject.seal(media(), binding(), NOW),
      'RESOLVED_MEDIA_GRANT_UNAVAILABLE',
      [secret, PRIVATE_URL],
    );
  });

  it('rejects oversized plaintext returned by a hostile sealer', async () => {
    const sealer: AesGcmSealer = {
      seal: vi.fn(async () => 'v1.AA.AA'),
      open: vi.fn(async () => 'A'.repeat(8_193)),
    };
    const subject = createResolvedMediaGrantCodec(sealer);

    await expectCodecError(
      subject.open('v1.AA.AA', binding(), NOW),
      'RESOLVED_MEDIA_GRANT_INVALID',
    );
  });
});

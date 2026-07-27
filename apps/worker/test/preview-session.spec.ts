import { describe, expect, it, vi } from 'vitest';

import type { ProbedMedia } from '../src/resolver/media-probe.js';
import {
  createPreviewCapabilityCodec,
  PREVIEW_CAPABILITY_TTL_MS,
  PreviewCapabilityError,
} from '../src/security/preview-capability.js';
import { parseCdnUrl } from '../src/security/upstream-policy.js';
import { encodeBase64Url } from '../src/utils/base64url.js';
import {
  createPreviewSessionService,
  type IssuePreviewSessionInput,
} from '../src/workflows/preview-session.js';

const NOW = Date.parse('2026-07-27T08:00:00.000Z');
const ENCRYPTION_KEY = encodeBase64Url(new Uint8Array(32).fill(9));
const SESSION_HASH = encodeBase64Url(new Uint8Array(32).fill(1));
const OTHER_SESSION_HASH = encodeBase64Url(new Uint8Array(32).fill(2));
const input: IssuePreviewSessionInput = {
  identity: {
    rawId: encodeBase64Url(new Uint8Array(32).fill(3)),
    sessionHash: SESSION_HASH,
  },
  csrfHash: encodeBase64Url(new Uint8Array(32).fill(4)),
  resolveId: encodeBase64Url(new Uint8Array(24).fill(5)),
  candidateId: encodeBase64Url(new Uint8Array(24).fill(6)),
};
const PRIVATE_CDN_URL = 'https://scontent.cdninstagram.com/o1/v/t16/f2/m69/video.mp4?token=private';
const media: ProbedMedia = {
  finalUrl: parseCdnUrl(PRIVATE_CDN_URL),
  contentType: 'video/mp4',
  contentLength: 100,
  rangeCapability: 'bytes',
  strongEtag: '"strong-v1"',
  lastModified: null,
  validator: { kind: 'etag', value: '"strong-v1"' },
  completionReliable: true,
  probeMethod: 'head',
};

describe('preview capability', () => {
  it('binds an opaque CDN target to one browser session for exactly 20 minutes', async () => {
    const codec = await createPreviewCapabilityCodec(ENCRYPTION_KEY);
    const issued = await codec.seal(media, SESSION_HASH, NOW);

    expect(issued.expiresAt).toBe(NOW + 20 * 60 * 1000);
    expect(issued.expiresAt - NOW).toBe(PREVIEW_CAPABILITY_TTL_MS);
    expect(issued.capability).not.toContain(PRIVATE_CDN_URL);
    expect(issued.capability).not.toContain('cdninstagram');
    await expect(
      codec.open(issued.capability, SESSION_HASH, issued.expiresAt - 1),
    ).resolves.toEqual(parseCdnUrl(PRIVATE_CDN_URL));
    await expect(codec.open(issued.capability, OTHER_SESSION_HASH, NOW)).rejects.toMatchObject({
      code: 'PREVIEW_CAPABILITY_INVALID',
    });
    await expect(
      codec.open(issued.capability, SESSION_HASH, issued.expiresAt),
    ).rejects.toMatchObject({ code: 'PREVIEW_CAPABILITY_EXPIRED' });
  });

  it('rejects tampering and a target outside the central CDN allowlist', async () => {
    const codec = await createPreviewCapabilityCodec(ENCRYPTION_KEY);
    const issued = await codec.seal(media, SESSION_HASH, NOW);
    const tampered = `${issued.capability.slice(0, -1)}${issued.capability.endsWith('A') ? 'B' : 'A'}`;
    const unsafeMedia = {
      ...media,
      finalUrl: { url: new URL('https://attacker.example/video.mp4') },
    } as ProbedMedia;

    await expect(codec.open(tampered, SESSION_HASH, NOW)).rejects.toBeInstanceOf(
      PreviewCapabilityError,
    );
    await expect(codec.seal(unsafeMedia, SESSION_HASH, NOW)).rejects.toMatchObject({
      code: 'PREVIEW_CAPABILITY_INVALID',
    });
  });
});

describe('preview session issuance', () => {
  it('releases the resolved candidate after sealing so normal download issuance remains available', async () => {
    const codec = await createPreviewCapabilityCodec(ENCRYPTION_KEY);
    const claim = vi.fn(async () => ({
      reservationId: encodeBase64Url(new Uint8Array(24).fill(7)),
      reservationExpiresAt: NOW + 30_000,
      filename: 'threads_Abcde_1.mp4',
      shortcode: 'Abcde',
      media,
    }));
    const release = vi.fn(async () => undefined);
    const service = createPreviewSessionService({
      capabilities: codec,
      resolvedMedia: { claim, release },
      now: () => NOW,
    });

    const issued = await service.issue(input);

    expect(claim).toHaveBeenCalledWith(input);
    expect(release).toHaveBeenCalledWith({
      ...input,
      reservationId: encodeBase64Url(new Uint8Array(24).fill(7)),
    });
    expect(issued.expiresAt).toBe(NOW + PREVIEW_CAPABILITY_TTL_MS);
    await expect(
      service.open({ capability: issued.capability, sessionHash: SESSION_HASH }),
    ).resolves.toEqual(parseCdnUrl(PRIVATE_CDN_URL));
  });
});

import { describe, expect, it } from 'vitest';

import type { ProbedMedia } from '../src/resolver/media-probe.js';
import {
  decodeProbedMediaWire,
  encodeProbedMediaWire,
} from '../src/security/resolved-media-wire.js';
import { parseCdnUrl } from '../src/security/upstream-policy.js';

const PRIVATE_URL = 'https://video.cdninstagram.com/media/private.mp4?token=private-wire-url';
const LAST_MODIFIED = 'Mon, 01 Jan 2024 00:00:00 GMT';

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

function wire(): Record<string, unknown> {
  return {
    finalUrl: PRIVATE_URL,
    contentType: 'video/mp4',
    contentLength: 42,
    rangeCapability: 'bytes',
    strongEtag: '"strong-v1"',
    lastModified: LAST_MODIFIED,
    completionReliable: true,
    probeMethod: 'head',
  };
}

function withoutField(value: Record<string, unknown>, field: string): Record<string, unknown> {
  const copy = { ...value };
  delete copy[field];
  return copy;
}

describe('resolved media wire codec', () => {
  it('encodes the exact eight-field shape in canonical JSON key order', () => {
    const encoded = encodeProbedMediaWire(media());

    expect(Object.keys(encoded)).toEqual([
      'finalUrl',
      'contentType',
      'contentLength',
      'rangeCapability',
      'strongEtag',
      'lastModified',
      'completionReliable',
      'probeMethod',
    ]);
    expect(encoded).toEqual(wire());
    expect(JSON.stringify(encoded)).toBe(JSON.stringify(wire()));
    expect(decodeProbedMediaWire(encoded)).toEqual(media());
  });

  it.each([
    ['extra field', { ...wire(), rawCookie: 'private' }],
    ['missing field', withoutField(wire(), 'probeMethod')],
    ['runtime validator', { ...wire(), validator: media().validator }],
    [
      'attacker URL',
      { ...wire(), finalUrl: 'https://video.cdninstagram.com.attacker.example/private.mp4' },
    ],
    [
      'non-canonical URL',
      { ...wire(), finalUrl: 'https://VIDEO.CDNINSTAGRAM.COM:443/media/private.mp4' },
    ],
    ['non-canonical MIME', { ...wire(), contentType: ' video/mp4 ' }],
    ['invalid content length', { ...wire(), contentLength: 0 }],
    ['weak ETag', { ...wire(), strongEtag: 'W/"weak"' }],
    ['invalid Last-Modified', { ...wire(), lastModified: 'private-date' }],
    ['completion drift', { ...wire(), completionReliable: false }],
    ['probe and range drift', { ...wire(), probeMethod: 'range-get', rangeCapability: 'unknown' }],
  ])('rejects decode input with %s', (_case, value) => {
    expect(decodeProbedMediaWire(value)).toBeNull();
  });

  it.each([
    [
      'unsafe URL',
      { finalUrl: { url: new URL('https://attacker.example/private.mp4?token=secret') } },
    ],
    ['validator drift', { validator: { kind: 'etag', value: '"other"' } }],
    ['extra runtime field', { privateTarget: PRIVATE_URL }],
  ])('rejects forged runtime media with a data-free error for %s', (_case, override) => {
    const forged = { ...media(), ...override } as unknown as ProbedMedia;
    let caught: unknown;
    try {
      encodeProbedMediaWire(forged);
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught).toMatchObject({ message: 'PROBED_MEDIA_WIRE_INVALID' });
    expect((caught as Error).message).not.toContain(PRIVATE_URL);
    expect((caught as Error).message).not.toContain('attacker.example');
  });
});

import { describe, expect, it } from 'vitest';

import {
  decodeBase64Url,
  encodeBase64Url,
  InvalidBase64UrlError,
  isCanonicalBase64UrlWithExactBytes,
  isCanonicalBase64UrlWithMinimumBytes,
} from '../src/utils/base64url.js';

function byteSequence(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => index % 256);
}

describe('base64url codec', () => {
  it('round-trips bytes using canonical unpadded URL-safe encoding', () => {
    const bytes = Uint8Array.from([0, 1, 2, 253, 254, 255]);

    expect(encodeBase64Url(bytes)).toBe('AAEC_f7_');
    expect(encodeBase64Url(bytes.buffer)).toBe('AAEC_f7_');
    expect(decodeBase64Url('AAEC_f7_')).toEqual(bytes);
    expect(decodeBase64Url('')).toEqual(new Uint8Array());
  });

  it('preserves every byte value across the code-point conversion boundary', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, value) => value);

    expect(decodeBase64Url(encodeBase64Url(bytes))).toEqual(bytes);
  });

  it.each(['a', 'abc=', 'abc+', 'abc/', 'abc\n', 'AB'])(
    'rejects malformed or non-canonical input: %s',
    (value) => {
      expect(() => decodeBase64Url(value)).toThrow(InvalidBase64UrlError);
    },
  );
});

describe('canonical base64url byte predicates', () => {
  it('accepts only the exact decoded byte length', () => {
    expect(isCanonicalBase64UrlWithExactBytes(encodeBase64Url(byteSequence(23)), 24)).toBe(false);
    expect(isCanonicalBase64UrlWithExactBytes(encodeBase64Url(byteSequence(24)), 24)).toBe(true);
    expect(isCanonicalBase64UrlWithExactBytes(encodeBase64Url(byteSequence(25)), 24)).toBe(false);
  });

  it('accepts the minimum decoded byte length and larger values', () => {
    expect(isCanonicalBase64UrlWithMinimumBytes(encodeBase64Url(byteSequence(15)), 16)).toBe(false);
    expect(isCanonicalBase64UrlWithMinimumBytes(encodeBase64Url(byteSequence(16)), 16)).toBe(true);
    expect(isCanonicalBase64UrlWithMinimumBytes(encodeBase64Url(byteSequence(17)), 16)).toBe(true);
  });

  it.each([
    ['padded encoding', '_w=='],
    ['standard alphabet', '/w'],
    ['non-canonical tail bits', 'AB'],
    ['null', null],
    ['number', 1],
  ] as const)('rejects %s without throwing', (_case, value) => {
    expect(isCanonicalBase64UrlWithExactBytes(value, 1)).toBe(false);
    expect(isCanonicalBase64UrlWithMinimumBytes(value, 1)).toBe(false);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid byte threshold: %s',
    (threshold) => {
      const encoded = encodeBase64Url(byteSequence(24));

      expect(isCanonicalBase64UrlWithExactBytes(encoded, threshold)).toBe(false);
      expect(isCanonicalBase64UrlWithMinimumBytes(encoded, threshold)).toBe(false);
    },
  );
});

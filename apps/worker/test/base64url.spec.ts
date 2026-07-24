import { describe, expect, it } from 'vitest';

import { decodeBase64Url, encodeBase64Url, InvalidBase64UrlError } from '../src/utils/base64url.js';

describe('base64url codec', () => {
  it('round-trips bytes using canonical unpadded URL-safe encoding', () => {
    const bytes = Uint8Array.from([0, 1, 2, 253, 254, 255]);

    expect(encodeBase64Url(bytes)).toBe('AAEC_f7_');
    expect(encodeBase64Url(bytes.buffer)).toBe('AAEC_f7_');
    expect(decodeBase64Url('AAEC_f7_')).toEqual(bytes);
    expect(decodeBase64Url('')).toEqual(new Uint8Array());
  });

  it.each(['a', 'abc=', 'abc+', 'abc/', 'abc\n', 'AB'])(
    'rejects malformed or non-canonical input: %s',
    (value) => {
      expect(() => decodeBase64Url(value)).toThrow(InvalidBase64UrlError);
    },
  );
});

import { describe, expect, it, vi } from 'vitest';

import type { HeaderSource } from '../src/security/browser-session.js';
import { extractClientIp, hashClientIp } from '../src/security/client-ip.js';
import type { KeyedIdentifierHasher } from '../src/security/cryptography.js';

function headerSource(value: string | null): HeaderSource {
  return { get: vi.fn((name: string) => (name === 'CF-Connecting-IP' ? value : null)) };
}

describe('Cloudflare client IP extraction', () => {
  it.each([
    '0.0.0.0',
    '203.0.113.42',
    '255.255.255.255',
    '2001:db8::1',
    '::',
    '::1',
    [`::${'f'.repeat(4)}`, ['192', '0', '2', '128'].join('.')].join(':'),
    Array.from({ length: 8 }, (_, index) => String(index + 1)).join(':'),
  ])('accepts a strict IPv4 or IPv6 value: %s', (value) => {
    expect(extractClientIp(headerSource(value))).toBe(value);
  });

  it.each([
    null,
    '',
    ' 203.0.113.42',
    '203.0.113.42 ',
    '203.0.113.42, 198.51.100.1',
    '203.0.113.999',
    '203.0.113',
    '01.2.3.4',
    '[2001:db8::1]',
    '2001:db8::1%eth0',
    '2001:::1',
    '2001:db8::1:',
    '1:2:3:4:5:6:7',
    '1:2:3:4:5:6:7:8:9',
    'private-client-address',
    'f'.repeat(65),
    '203.0.113.42\n',
  ])('rejects a missing or malformed value without reflecting it: %s', (value) => {
    const action = () => extractClientIp(headerSource(value));
    expect(action).toThrowError('CLIENT_IP_INVALID');
    try {
      action();
    } catch (error) {
      if (value !== null && value !== '') {
        expect((error as Error).message).not.toContain(value);
      }
    }
  });

  it('reads only CF-Connecting-IP and ignores forwarding aliases', () => {
    const headers = new Headers({
      'x-forwarded-for': '203.0.113.42',
      'x-real-ip': '203.0.113.42',
    });
    expect(() => extractClientIp(headers)).toThrowError('CLIENT_IP_INVALID');
  });

  it('keys the raw value in the resolve-ip domain and returns only the opaque hash', async () => {
    const hash = 'H'.repeat(43);
    const hasher: KeyedIdentifierHasher = { hash: vi.fn(async () => hash) };
    const raw = '203.0.113.42';

    await expect(hashClientIp(headerSource(raw), hasher)).resolves.toBe(hash);
    expect(hasher.hash).toHaveBeenCalledWith('resolve-ip', raw);
    expect(hash).not.toContain(raw);
  });

  it('maps hashing failures to a safe typed error', async () => {
    const raw = '203.0.113.42';
    const hasher: KeyedIdentifierHasher = {
      hash: vi.fn(async () => Promise.reject(new Error(`provider leaked ${raw}`))),
    };
    await expect(hashClientIp(headerSource(raw), hasher)).rejects.toMatchObject({
      code: 'CLIENT_IP_HASH_FAILED',
      message: 'CLIENT_IP_HASH_FAILED',
    });
  });
});

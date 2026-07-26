import { describe, expect, it } from 'vitest';

import {
  createKeyedIdentifierHasher,
  createAesGcmSealer,
  createOpaqueId,
  createOpaqueValueSigner,
  hashIdentifier,
  importEncryptionKey,
  importSigningKey,
} from '../src/security/cryptography.js';
import { decodeBase64Url, encodeBase64Url } from '../src/utils/base64url.js';

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

function alterBase64Url(value: string): string {
  const decoded = decodeBase64Url(value);
  decoded[decoded.length - 1] = (decoded[decoded.length - 1] ?? 0) ^ 1;
  return encodeBase64Url(decoded);
}

const firstKey = encodeBase64(bytes(32));
const secondKey = encodeBase64(bytes(32, 73));

describe('opaque identifiers', () => {
  it('creates distinct URL-safe identifiers with 192 bits by default', () => {
    const identifiers = Array.from({ length: 8 }, () => createOpaqueId());

    expect(new Set(identifiers)).toHaveLength(8);
    for (const identifier of identifiers) {
      expect(identifier).toMatch(/^[A-Za-z0-9_-]{32}$/u);
      expect(decodeBase64Url(identifier)).toHaveLength(24);
    }
  });

  it('allows callers to request whole-byte entropy of at least 128 bits', () => {
    expect(decodeBase64Url(createOpaqueId(128))).toHaveLength(16);
    expect(() => createOpaqueId(127)).toThrow(RangeError);
    expect(() => createOpaqueId(129)).toThrow(RangeError);
  });

  it('hashes identifiers with SHA-256 into base64url', async () => {
    await expect(hashIdentifier('abc')).resolves.toBe(
      'ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0',
    );
  });
});

describe('cryptographic key import', () => {
  it('imports non-extractable 256-bit signing and encryption keys', async () => {
    const signingKey = await importSigningKey(firstKey);
    const encryptionKey = await importEncryptionKey(firstKey);

    expect(signingKey).toMatchObject({ extractable: false, type: 'secret' });
    expect(signingKey.algorithm).toMatchObject({ name: 'HMAC', length: 256 });
    expect(signingKey.usages).toEqual(['sign', 'verify']);
    expect(encryptionKey).toMatchObject({ extractable: false, type: 'secret' });
    expect(encryptionKey.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    expect(encryptionKey.usages).toEqual(['encrypt', 'decrypt']);
  });

  it('preserves high-byte key material through binary decoding', async () => {
    const valueSigner = createOpaqueValueSigner(
      await importSigningKey(encodeBase64(bytes(32, 240))),
    );
    const opaqueValue = encodeBase64Url(bytes(16, 128));
    const signedValue = await valueSigner.sign(opaqueValue);

    await expect(valueSigner.verify(signedValue)).resolves.toBe(opaqueValue);
  });

  it.each([importSigningKey, importEncryptionKey])(
    'rejects non-32-byte, malformed, and non-canonical key material',
    async (importer) => {
      await expect(importer(encodeBase64(bytes(31)))).rejects.toThrow('exactly 32 bytes');
      await expect(importer(`${firstKey}\n`)).rejects.toThrow('exactly 32 bytes');
      await expect(importer(firstKey.replace(/=$/u, ''))).rejects.toThrow('exactly 32 bytes');
      await expect(importer('not-base64')).rejects.toThrow('exactly 32 bytes');
    },
  );
});

describe('opaque value signatures', () => {
  it('round-trips an opaque value with HMAC-SHA256', async () => {
    const signer = createOpaqueValueSigner(await importSigningKey(firstKey));
    const value = createOpaqueId(128);
    const signedValue = await signer.sign(value);

    expect(signedValue).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
    await expect(signer.verify(signedValue)).resolves.toBe(value);
  });

  it('returns null for a tampered value or signature and for a different key', async () => {
    const signer = createOpaqueValueSigner(await importSigningKey(firstKey));
    const otherSigner = createOpaqueValueSigner(await importSigningKey(secondKey));
    const signedValue = await signer.sign(createOpaqueId(128));
    const [value, signature] = signedValue.split('.');
    const tamperedValue = `${alterBase64Url(value ?? '')}.${signature ?? ''}`;
    const tamperedSignature = `${value ?? ''}.${alterBase64Url(signature ?? '')}`;

    await expect(signer.verify(tamperedValue)).resolves.toBeNull();
    await expect(signer.verify(tamperedSignature)).resolves.toBeNull();
    await expect(otherSigner.verify(signedValue)).resolves.toBeNull();
  });

  it.each(['', 'opaque', '.signature', 'opaque.signature.extra', '!.AA', 'AA.AA'])(
    'returns null for malformed signed input: %s',
    async (value) => {
      const signer = createOpaqueValueSigner(await importSigningKey(firstKey));
      await expect(signer.verify(value)).resolves.toBeNull();
    },
  );
});

describe('keyed identifier hashes', () => {
  it('is deterministic, domain-separated, and never contains raw identifiers', async () => {
    const hasher = createKeyedIdentifierHasher(await importSigningKey(firstKey));
    const raw = '203.0.113.42';
    const first = await hasher.hash('resolve-ip', raw);

    await expect(hasher.hash('resolve-ip', raw)).resolves.toBe(first);
    await expect(hasher.hash('other-context', raw)).resolves.not.toBe(first);
    await expect(hasher.hash('resolve-ip', '203.0.113.43')).resolves.not.toBe(first);
    await expect(hasher.hash('ab', 'c')).resolves.not.toBe(await hasher.hash('a', 'bc'));
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(first).not.toContain(raw);
  });

  it('maps signing failures to an input-independent safe error', async () => {
    const hasher = createKeyedIdentifierHasher({} as CryptoKey);
    const raw = 'private-client-address';
    await expect(hasher.hash('resolve-ip', raw)).rejects.toThrow('Identifier could not be keyed.');
    try {
      await hasher.hash('resolve-ip', raw);
    } catch (error) {
      expect((error as Error).message).not.toContain(raw);
    }
  });
});

describe('AES-256-GCM sealed UTF-8 values', () => {
  it('round-trips Unicode plaintext with caller-supplied authenticated data', async () => {
    const sealer = createAesGcmSealer(await importEncryptionKey(firstKey));
    const sealed = await sealer.seal('短期權杖 🔐', 'resolver-credential:v1');

    expect(sealed.startsWith('v1.')).toBe(true);
    await expect(sealer.open(sealed, 'resolver-credential:v1')).resolves.toBe('短期權杖 🔐');
  });

  it('uses a fresh 96-bit IV for every sealed value', async () => {
    const sealer = createAesGcmSealer(await importEncryptionKey(firstKey));
    const first = await sealer.seal('same plaintext', 'same-aad');
    const second = await sealer.seal('same plaintext', 'same-aad');
    const firstIv = first.split('.')[1] ?? '';
    const secondIv = second.split('.')[1] ?? '';

    expect(decodeBase64Url(firstIv)).toHaveLength(12);
    expect(decodeBase64Url(secondIv)).toHaveLength(12);
    expect(secondIv).not.toBe(firstIv);
    expect(second).not.toBe(first);
  });

  it('rejects ciphertext tampering, wrong authenticated data, and a wrong key', async () => {
    const sealer = createAesGcmSealer(await importEncryptionKey(firstKey));
    const otherSealer = createAesGcmSealer(await importEncryptionKey(secondKey));
    const sealed = await sealer.seal('vault value', 'vault:record-1');
    const [version, iv, ciphertext] = sealed.split('.');
    const tampered = `${version ?? ''}.${iv ?? ''}.${alterBase64Url(ciphertext ?? '')}`;

    await expect(sealer.open(tampered, 'vault:record-1')).rejects.toThrow(
      'Sealed value could not be opened.',
    );
    await expect(sealer.open(sealed, 'vault:record-2')).rejects.toThrow(
      'Sealed value could not be opened.',
    );
    await expect(otherSealer.open(sealed, 'vault:record-1')).rejects.toThrow(
      'Sealed value could not be opened.',
    );
  });

  it.each(['', 'v2.AA.AA', 'v1.AA.AA', 'v1.!.AA', 'v1.AA.AA.extra'])(
    'rejects malformed sealed input without exposing its contents: %s',
    async (value) => {
      const sealer = createAesGcmSealer(await importEncryptionKey(firstKey));
      await expect(sealer.open(value, 'aad')).rejects.toThrow('Sealed value could not be opened.');
    },
  );
});

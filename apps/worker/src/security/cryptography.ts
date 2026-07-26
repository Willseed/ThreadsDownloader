import { decodeBase64Url, encodeBase64Url } from '../utils/base64url.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const keyBytes = 32;
const defaultIdEntropyBits = 192;
const minimumIdEntropyBits = 128;
const maximumRandomBytes = 65_536;
const hmacSignatureBytes = 32;
const aesGcmIvBytes = 12;
const aesGcmTagBytes = 16;
const sealedValueVersion = 'v1';
const canonicalBase64Key = /^[A-Za-z0-9+/]{43}=$/u;

export interface OpaqueValueSigner {
  sign(value: string): Promise<string>;
  verify(signedValue: string): Promise<string | null>;
}

export interface AesGcmSealer {
  seal(plaintext: string, additionalAuthenticatedData: string): Promise<string>;
  open(sealedValue: string, additionalAuthenticatedData: string): Promise<string>;
}

export interface KeyedIdentifierHasher {
  hash(context: string, value: string): Promise<string>;
}

function invalidKeyMaterial(): Error {
  return new Error('Key material must be canonical base64 encoding of exactly 32 bytes.');
}

function operationFailed(message: string): Error {
  return new Error(message);
}

function domainSeparatedIdentifier(context: string, value: string): Uint8Array<ArrayBuffer> {
  const contextBytes = encoder.encode(context);
  const valueBytes = encoder.encode(value);
  if (contextBytes.byteLength > 0xff_ff_ff_ff || valueBytes.byteLength > 0xff_ff_ff_ff) {
    throw operationFailed('Identifier could not be keyed.');
  }
  const message = new Uint8Array(9 + contextBytes.byteLength + valueBytes.byteLength);
  const lengths = new DataView(message.buffer);
  message[0] = 1;
  lengths.setUint32(1, contextBytes.byteLength);
  message.set(contextBytes, 5);
  lengths.setUint32(5 + contextBytes.byteLength, valueBytes.byteLength);
  message.set(valueBytes, 9 + contextBytes.byteLength);
  contextBytes.fill(0);
  valueBytes.fill(0);
  return message;
}

function decodeKeyMaterial(encodedKey: string): Uint8Array<ArrayBuffer> {
  if (!canonicalBase64Key.test(encodedKey)) {
    throw invalidKeyMaterial();
  }

  let binary: string;
  try {
    binary = atob(encodedKey);
  } catch {
    throw invalidKeyMaterial();
  }

  if (binary.length !== keyBytes || btoa(binary) !== encodedKey) {
    throw invalidKeyMaterial();
  }

  const bytes = new Uint8Array(keyBytes);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.codePointAt(index)!;
  }

  return bytes;
}

async function importKey(
  encodedKey: string,
  algorithm: HmacImportParams | AesKeyAlgorithm,
  usages: readonly KeyUsage[],
): Promise<CryptoKey> {
  const material = decodeKeyMaterial(encodedKey);

  try {
    return await crypto.subtle.importKey('raw', material, algorithm, false, usages);
  } catch {
    throw operationFailed('Cryptographic key could not be imported.');
  } finally {
    material.fill(0);
  }
}

function requireOpaqueValue(value: string): void {
  if (value.length === 0) {
    throw operationFailed('Opaque value must be non-empty canonical base64url.');
  }

  try {
    decodeBase64Url(value);
  } catch {
    throw operationFailed('Opaque value must be non-empty canonical base64url.');
  }
}

function parseSignedValue(signedValue: string): readonly [string, Uint8Array<ArrayBuffer>] | null {
  const separator = signedValue.indexOf('.');
  if (separator <= 0 || separator !== signedValue.lastIndexOf('.')) {
    return null;
  }

  const value = signedValue.slice(0, separator);
  const encodedSignature = signedValue.slice(separator + 1);

  try {
    requireOpaqueValue(value);
    const signature = decodeBase64Url(encodedSignature);
    return signature.byteLength === hmacSignatureBytes ? [value, signature] : null;
  } catch {
    return null;
  }
}

function parseSealedValue(
  sealedValue: string,
): readonly [Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>] {
  const parts = sealedValue.split('.');
  if (parts.length !== 3 || parts[0] !== sealedValueVersion) {
    throw operationFailed('Sealed value could not be opened.');
  }

  const iv = decodeBase64Url(parts[1] ?? '');
  const ciphertext = decodeBase64Url(parts[2] ?? '');
  if (iv.byteLength !== aesGcmIvBytes || ciphertext.byteLength < aesGcmTagBytes) {
    throw operationFailed('Sealed value could not be opened.');
  }

  return [iv, ciphertext];
}

export function createOpaqueId(entropyBits = defaultIdEntropyBits): string {
  const maximumEntropyBits = maximumRandomBytes * 8;
  if (
    !Number.isSafeInteger(entropyBits) ||
    entropyBits < minimumIdEntropyBits ||
    entropyBits > maximumEntropyBits ||
    entropyBits % 8 !== 0
  ) {
    throw new RangeError(
      `Opaque ID entropy must be a whole-byte value from ${minimumIdEntropyBits} to ${maximumEntropyBits} bits.`,
    );
  }

  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(entropyBits / 8)));
}

export async function hashIdentifier(identifier: string): Promise<string> {
  try {
    return encodeBase64Url(await crypto.subtle.digest('SHA-256', encoder.encode(identifier)));
  } catch {
    throw operationFailed('Identifier could not be hashed.');
  }
}

export function importSigningKey(encodedKey: string): Promise<CryptoKey> {
  return importKey(encodedKey, { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign', 'verify']);
}

export function importEncryptionKey(encodedKey: string): Promise<CryptoKey> {
  return importKey(encodedKey, { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']);
}

export function createOpaqueValueSigner(key: CryptoKey): OpaqueValueSigner {
  return {
    async sign(value: string): Promise<string> {
      requireOpaqueValue(value);

      try {
        const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
        return `${value}.${encodeBase64Url(signature)}`;
      } catch {
        throw operationFailed('Opaque value could not be signed.');
      }
    },

    async verify(signedValue: string): Promise<string | null> {
      const parsed = parseSignedValue(signedValue);
      if (parsed === null) {
        return null;
      }

      const [value, signature] = parsed;
      try {
        const verified = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(value));
        return verified ? value : null;
      } catch {
        return null;
      }
    },
  };
}

export function createKeyedIdentifierHasher(key: CryptoKey): KeyedIdentifierHasher {
  return {
    async hash(context: string, value: string): Promise<string> {
      let message: Uint8Array<ArrayBuffer> | null = null;
      try {
        message = domainSeparatedIdentifier(context, value);
        return encodeBase64Url(await crypto.subtle.sign('HMAC', key, message));
      } catch {
        throw operationFailed('Identifier could not be keyed.');
      } finally {
        message?.fill(0);
      }
    },
  };
}

export function createAesGcmSealer(key: CryptoKey): AesGcmSealer {
  return {
    async seal(plaintext: string, additionalAuthenticatedData: string): Promise<string> {
      const iv = crypto.getRandomValues(new Uint8Array(aesGcmIvBytes));
      const encodedPlaintext = encoder.encode(plaintext);

      try {
        const ciphertext = await crypto.subtle.encrypt(
          {
            name: 'AES-GCM',
            iv,
            additionalData: encoder.encode(additionalAuthenticatedData),
            tagLength: aesGcmTagBytes * 8,
          },
          key,
          encodedPlaintext,
        );
        return `${sealedValueVersion}.${encodeBase64Url(iv)}.${encodeBase64Url(ciphertext)}`;
      } catch {
        throw operationFailed('Value could not be sealed.');
      } finally {
        encodedPlaintext.fill(0);
      }
    },

    async open(sealedValue: string, additionalAuthenticatedData: string): Promise<string> {
      try {
        const [iv, ciphertext] = parseSealedValue(sealedValue);
        const plaintext = new Uint8Array(
          await crypto.subtle.decrypt(
            {
              name: 'AES-GCM',
              iv,
              additionalData: encoder.encode(additionalAuthenticatedData),
              tagLength: aesGcmTagBytes * 8,
            },
            key,
            ciphertext,
          ),
        );

        try {
          return decoder.decode(plaintext);
        } finally {
          plaintext.fill(0);
        }
      } catch {
        throw operationFailed('Sealed value could not be opened.');
      }
    },
  };
}

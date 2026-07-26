const canonicalBase64Url = /^[A-Za-z0-9_-]*$/u;

export class InvalidBase64UrlError extends Error {
  constructor() {
    super('Value must use canonical unpadded base64url encoding.');
    this.name = 'InvalidBase64UrlError';
  }
}

export function encodeBase64Url(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }

  const encoded = btoa(binary).replaceAll('+', '-').replaceAll('/', '_');
  const paddingStart = encoded.indexOf('=');
  return paddingStart === -1 ? encoded : encoded.slice(0, paddingStart);
}

export function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!canonicalBase64Url.test(value) || value.length % 4 === 1) {
    throw new InvalidBase64UrlError();
  }

  const paddingLength = (4 - (value.length % 4)) % 4;
  const encoded = value
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(value.length + paddingLength, '=');

  try {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.codePointAt(index)!;
    }

    if (encodeBase64Url(bytes) !== value) {
      throw new InvalidBase64UrlError();
    }

    return bytes;
  } catch (error: unknown) {
    if (error instanceof InvalidBase64UrlError) {
      throw error;
    }

    throw new InvalidBase64UrlError();
  }
}

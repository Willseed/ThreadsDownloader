import { createOpaqueId, hashIdentifier, type OpaqueValueSigner } from './cryptography.js';
import { decodeBase64Url } from '../utils/base64url.js';

export const SESSION_COOKIE_NAME = '__Host-td_session';
export const MAX_COOKIE_HEADER_BYTES = 4096;
export const SESSION_ID_BYTES = 32;
export const CSRF_TOKEN_BYTES = 32;
export const SESSION_TTL_SECONDS = 43_200;
export const MAX_JSON_BODY_BYTES = 16_384;

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export type BrowserSessionErrorCode =
  | 'BODY_INVALID'
  | 'BODY_TOO_LARGE'
  | 'CONTENT_LENGTH_INVALID'
  | 'CONTENT_TYPE_INVALID'
  | 'ORIGIN_INVALID'
  | 'SESSION_COOKIE_INVALID'
  | 'SESSION_OPERATION_FAILED';

export class BrowserSessionError extends Error {
  constructor(readonly code: BrowserSessionErrorCode) {
    super(code);
    this.name = 'BrowserSessionError';
  }
}

export interface BrowserSessionMaterial {
  readonly rawId: string;
  readonly signedCookie: string;
  readonly sessionHash: string;
  readonly csrfToken: string;
  readonly csrfHash: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly setCookie: string;
}

export interface ResumedBrowserSession {
  readonly rawId: string;
  readonly sessionHash: string;
}

export interface RotatedCsrfToken {
  readonly csrfToken: string;
  readonly csrfHash: string;
}

export interface HeaderSource {
  get(name: string): string | null;
}

export interface ValidatedMutationHeaders {
  readonly contentLength: number | null;
}

function fail(code: BrowserSessionErrorCode): never {
  throw new BrowserSessionError(code);
}

function isCookieNameCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? -1;
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    "!#$%&'*+-.^_`|~".includes(character)
  );
}

function isCookieValueCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? -1;
  return (
    code === 33 ||
    (code >= 35 && code <= 43) ||
    (code >= 45 && code <= 58) ||
    (code >= 60 && code <= 126)
  );
}

function everyCharacter(value: string, predicate: (character: string) => boolean): boolean {
  for (const character of value) {
    if (!predicate(character)) {
      return false;
    }
  }
  return true;
}

function parseSessionCookie(cookieHeader: string | null): string {
  if (
    cookieHeader === null ||
    new TextEncoder().encode(cookieHeader).byteLength > MAX_COOKIE_HEADER_BYTES
  ) {
    return fail('SESSION_COOKIE_INVALID');
  }

  let sessionCookie: string | null = null;
  for (const rawPart of cookieHeader.split(';')) {
    const part = rawPart.trim();
    const separator = part.indexOf('=');
    if (
      separator <= 0 ||
      separator !== part.lastIndexOf('=') ||
      !everyCharacter(part.slice(0, separator), isCookieNameCharacter) ||
      !everyCharacter(part.slice(separator + 1), isCookieValueCharacter)
    ) {
      return fail('SESSION_COOKIE_INVALID');
    }

    if (part.slice(0, separator) === SESSION_COOKIE_NAME) {
      if (sessionCookie !== null || separator === part.length - 1) {
        return fail('SESSION_COOKIE_INVALID');
      }
      sessionCookie = part.slice(separator + 1);
    }
  }

  return sessionCookie ?? fail('SESSION_COOKIE_INVALID');
}

function parseContentLength(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  if (value === '') {
    return fail('CONTENT_LENGTH_INVALID');
  }

  let length = 0;
  for (const character of value) {
    const code = character.codePointAt(0) ?? -1;
    if (code < 48 || code > 57) {
      return fail('CONTENT_LENGTH_INVALID');
    }
    length = length * 10 + code - 48;
    if (!Number.isSafeInteger(length)) {
      return fail('CONTENT_LENGTH_INVALID');
    }
  }
  if (length > MAX_JSON_BODY_BYTES) {
    return fail('BODY_TOO_LARGE');
  }
  return length;
}

function isJsonContentType(value: string | null): boolean {
  if (value === null) {
    return false;
  }
  const parts = value.split(';').map((part) => part.trim().toLowerCase());
  return (
    parts[0] === 'application/json' &&
    (parts.length === 1 || (parts.length === 2 && parts[1] === 'charset=utf-8'))
  );
}

export async function createBrowserSession(
  signer: OpaqueValueSigner,
  issuedAt = Date.now(),
): Promise<BrowserSessionMaterial> {
  if (
    !Number.isSafeInteger(issuedAt) ||
    issuedAt < 0 ||
    issuedAt > Number.MAX_SAFE_INTEGER - SESSION_TTL_SECONDS * 1000
  ) {
    return fail('SESSION_OPERATION_FAILED');
  }
  try {
    const rawId = createOpaqueId(SESSION_ID_BYTES * 8);
    const csrfToken = createOpaqueId(CSRF_TOKEN_BYTES * 8);
    const [signedCookie, sessionHash, csrfHash] = await Promise.all([
      signer.sign(rawId),
      hashIdentifier(rawId),
      hashIdentifier(csrfToken),
    ]);
    return {
      rawId,
      signedCookie,
      sessionHash,
      csrfToken,
      csrfHash,
      issuedAt,
      expiresAt: issuedAt + SESSION_TTL_SECONDS * 1000,
      setCookie: `${SESSION_COOKIE_NAME}=${signedCookie}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
    };
  } catch {
    return fail('SESSION_OPERATION_FAILED');
  }
}

export async function resumeBrowserSession(
  cookieHeader: string | null,
  signer: OpaqueValueSigner,
): Promise<ResumedBrowserSession> {
  const signedCookie = parseSessionCookie(cookieHeader);
  let rawId: string | null;
  try {
    rawId = await signer.verify(signedCookie);
  } catch {
    return fail('SESSION_COOKIE_INVALID');
  }
  if (rawId === null) {
    return fail('SESSION_COOKIE_INVALID');
  }
  try {
    if (decodeBase64Url(rawId).byteLength !== SESSION_ID_BYTES) {
      return fail('SESSION_COOKIE_INVALID');
    }
  } catch {
    return fail('SESSION_COOKIE_INVALID');
  }
  try {
    return { rawId, sessionHash: await hashIdentifier(rawId) };
  } catch {
    return fail('SESSION_OPERATION_FAILED');
  }
}

export async function rotateCsrfToken(): Promise<RotatedCsrfToken> {
  try {
    const csrfToken = createOpaqueId(CSRF_TOKEN_BYTES * 8);
    return { csrfToken, csrfHash: await hashIdentifier(csrfToken) };
  } catch {
    return fail('SESSION_OPERATION_FAILED');
  }
}

export function validateMutationHeaders(
  headers: HeaderSource,
  expectedOrigin: string,
): ValidatedMutationHeaders {
  if (headers.get('origin') !== expectedOrigin) {
    return fail('ORIGIN_INVALID');
  }
  if (!isJsonContentType(headers.get('content-type'))) {
    return fail('CONTENT_TYPE_INVALID');
  }
  return { contentLength: parseContentLength(headers.get('content-length')) };
}

function validateDeclaredJsonLength(declaredLength: number | null | undefined): void {
  if (
    declaredLength !== undefined &&
    declaredLength !== null &&
    (!Number.isSafeInteger(declaredLength) || declaredLength < 0)
  ) {
    fail('CONTENT_LENGTH_INVALID');
  }
  if (
    declaredLength !== undefined &&
    declaredLength !== null &&
    declaredLength > MAX_JSON_BODY_BYTES
  ) {
    fail('BODY_TOO_LARGE');
  }
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // The public error must remain independent of stream cancellation failures.
  }
}

async function assertJsonChunkBounds(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  totalBytes: number,
  declaredLength: number | null | undefined,
): Promise<void> {
  if (totalBytes > MAX_JSON_BODY_BYTES) {
    await cancelReader(reader);
    fail('BODY_TOO_LARGE');
  }
  if (declaredLength !== undefined && declaredLength !== null && totalBytes > declaredLength) {
    await cancelReader(reader);
    fail('CONTENT_LENGTH_INVALID');
  }
}

export async function readBoundedJson(
  stream: ReadableStream<Uint8Array> | null,
  declaredLength?: number | null,
): Promise<unknown> {
  validateDeclaredJsonLength(declaredLength);
  if (stream === null) {
    return fail('BODY_INVALID');
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      if (!(result.value instanceof Uint8Array)) {
        return fail('BODY_INVALID');
      }
      totalBytes += result.value.byteLength;
      await assertJsonChunkBounds(reader, totalBytes, declaredLength);
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  if (declaredLength !== undefined && declaredLength !== null && totalBytes !== declaredLength) {
    return fail('CONTENT_LENGTH_INVALID');
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = utf8Decoder.decode(body);
    const parsed: unknown = JSON.parse(text) as unknown;
    return parsed;
  } catch {
    return fail('BODY_INVALID');
  }
}

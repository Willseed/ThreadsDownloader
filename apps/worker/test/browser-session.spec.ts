import { describe, expect, it, vi } from 'vitest';

import {
  BrowserSessionError,
  createBrowserSession,
  type HeaderSource,
  MAX_COOKIE_HEADER_BYTES,
  MAX_JSON_BODY_BYTES,
  readBoundedJson,
  resumeBrowserSession,
  rotateCsrfToken,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  validateMutationHeaders,
} from '../src/security/browser-session.js';
import {
  createOpaqueValueSigner,
  importSigningKey,
  type OpaqueValueSigner,
} from '../src/security/cryptography.js';

const encoder = new TextEncoder();

function mutationHeaders(contentLength: string): HeaderSource {
  const values = new Map([
    ['origin', 'https://threads.example'],
    ['content-type', 'application/json'],
    ['content-length', contentLength],
  ]);
  return { get: (name) => values.get(name) ?? null };
}

async function signer(): Promise<OpaqueValueSigner> {
  return createOpaqueValueSigner(
    await importSigningKey('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='),
  );
}

function expectSafeError(action: () => unknown, code: string, sensitive = 'secret'): void {
  expect(action).toThrowError(BrowserSessionError);
  try {
    action();
  } catch (error) {
    expect((error as BrowserSessionError).code).toBe(code);
    expect((error as Error).message).not.toContain(sensitive);
  }
}

async function expectSafeAsyncError(
  action: () => Promise<unknown>,
  code: string,
  sensitive = 'secret',
): Promise<void> {
  try {
    await action();
    throw new Error('expected browser session error');
  } catch (error) {
    expect(error).toBeInstanceOf(BrowserSessionError);
    expect((error as BrowserSessionError).code).toBe(code);
    expect((error as Error).message).not.toContain(sensitive);
  }
}

describe('browser session material', () => {
  it('creates signed and hashed session material with a host-only cookie', async () => {
    const session = await createBrowserSession(await signer(), 1_000);

    expect(session.expiresAt).toBe(1_000 + SESSION_TTL_SECONDS * 1000);
    expect(session.setCookie).toContain(`${SESSION_COOKIE_NAME}=${session.signedCookie}`);
    expect(session.setCookie).toContain('Path=/');
    expect(session.setCookie).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
    expect(session.setCookie).toContain('HttpOnly');
    expect(session.setCookie).toContain('Secure');
    expect(session.setCookie).toContain('SameSite=Lax');
    expect(session.setCookie).not.toContain('Domain');
  });

  it('resumes only a valid signed 32-byte session ID', async () => {
    const valueSigner = await signer();
    const created = await createBrowserSession(valueSigner);
    await expect(
      resumeBrowserSession(
        `${SESSION_COOKIE_NAME}=${created.signedCookie}; theme=dark`,
        valueSigner,
      ),
    ).resolves.toEqual({ rawId: created.rawId, sessionHash: created.sessionHash });

    const shortCookie = await valueSigner.sign('AAAAAAAAAAAAAAAAAAAAAA');
    await expectSafeAsyncError(
      () => resumeBrowserSession(`${SESSION_COOKIE_NAME}=${shortCookie}`, valueSigner),
      'SESSION_COOKIE_INVALID',
    );
  });

  it.each([
    null,
    '',
    `${SESSION_COOKIE_NAME}=broken.secret`,
    `${SESSION_COOKIE_NAME}=one; ${SESSION_COOKIE_NAME}=two`,
    `${SESSION_COOKIE_NAME}`,
    `${SESSION_COOKIE_NAME}=bad=value`,
    SESSION_COOKIE_NAME + '=😀',
    'emoji😀=value; ' + SESSION_COOKIE_NAME + '=signed',
    SESSION_COOKIE_NAME + '=\uD800',
  ])('rejects missing, malformed, duplicate, or tampered cookies', async (cookie) => {
    await expectSafeAsyncError(
      () => resumeBrowserSession(cookie, awaitableSigner),
      'SESSION_COOKIE_INVALID',
      cookie === null || cookie === '' ? 'absent' : cookie,
    );
  });

  const awaitableSigner: OpaqueValueSigner = {
    sign: async (value) => value,
    verify: async () => null,
  };

  it('rejects an oversized cookie header', async () => {
    const cookie = `x=${'a'.repeat(MAX_COOKIE_HEADER_BYTES)}`;
    await expectSafeAsyncError(
      () => resumeBrowserSession(cookie, awaitableSigner),
      'SESSION_COOKIE_INVALID',
      cookie,
    );
  });

  it('rotates CSRF material without reusing the prior token', async () => {
    const first = await rotateCsrfToken();
    const next = await rotateCsrfToken();
    expect(next.csrfToken).not.toBe(first.csrfToken);
    expect(next.csrfHash).not.toBe(first.csrfHash);
  });

  it('maps signer failures to a safe typed error', async () => {
    const failingSigner: OpaqueValueSigner = {
      sign: async () => {
        throw new Error('secret signer detail');
      },
      verify: async () => null,
    };
    await expectSafeAsyncError(
      () => createBrowserSession(failingSigner),
      'SESSION_OPERATION_FAILED',
      'secret signer detail',
    );
  });
});

describe('mutation request policy', () => {
  it.each([
    'application/json',
    'application/json; charset=utf-8',
    'Application/JSON; Charset=UTF-8',
  ])('accepts the exact origin and JSON content type', (contentType) => {
    expect(
      validateMutationHeaders(
        new Headers({
          origin: 'https://threads.example',
          'content-type': contentType,
          'content-length': '42',
        }),
        'https://threads.example',
      ),
    ).toEqual({ contentLength: 42 });
  });

  it.each([
    [new Headers({ 'content-type': 'application/json' }), 'ORIGIN_INVALID'],
    [
      new Headers({ origin: 'https://other.example', 'content-type': 'application/json' }),
      'ORIGIN_INVALID',
    ],
    [
      new Headers({ origin: 'https://threads.example', 'content-type': 'text/plain' }),
      'CONTENT_TYPE_INVALID',
    ],
    [
      new Headers({
        origin: 'https://threads.example',
        'content-type': 'application/json; charset=latin1',
      }),
      'CONTENT_TYPE_INVALID',
    ],
    [
      new Headers({
        origin: 'https://threads.example',
        'content-type': 'application/json',
        'content-length': '-1',
      }),
      'CONTENT_LENGTH_INVALID',
    ],
    [
      new Headers({
        origin: 'https://threads.example',
        'content-type': 'application/json',
        'content-length': `${MAX_JSON_BODY_BYTES + 1}`,
      }),
      'BODY_TOO_LARGE',
    ],
    [mutationHeaders('42😀'), 'CONTENT_LENGTH_INVALID'],
    [mutationHeaders('42\uD800'), 'CONTENT_LENGTH_INVALID'],
  ])('rejects unsafe mutation headers', (requestHeaders, code) => {
    expectSafeError(() => validateMutationHeaders(requestHeaders, 'https://threads.example'), code);
  });
});

describe('readBoundedJson', () => {
  it('reads chunked JSON as unknown using actual byte counts', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"value":'));
        controller.enqueue(encoder.encode('42}'));
        controller.close();
      },
    });
    await expect(readBoundedJson(stream)).resolves.toEqual({ value: 42 });
  });

  it('requires declared content length to match the actual bytes when supplied', async () => {
    const body = encoder.encode('{"value":42}');

    await expect(readBoundedJson(new Blob([body]).stream(), body.byteLength)).resolves.toEqual({
      value: 42,
    });
    await expectSafeAsyncError(
      () => readBoundedJson(new Blob([body]).stream(), body.byteLength - 1),
      'CONTENT_LENGTH_INVALID',
    );
    await expectSafeAsyncError(
      () => readBoundedJson(new Blob([body]).stream(), body.byteLength + 1),
      'CONTENT_LENGTH_INVALID',
    );
  });

  it('rejects declared and actual bodies over the shared limit as too large', async () => {
    await expectSafeAsyncError(
      () => readBoundedJson(new Blob(['{}']).stream(), MAX_JSON_BODY_BYTES + 1),
      'BODY_TOO_LARGE',
    );
    await expectSafeAsyncError(
      () =>
        readBoundedJson(
          new Blob([new Uint8Array(MAX_JSON_BODY_BYTES + 1)]).stream(),
          MAX_JSON_BODY_BYTES + 1,
        ),
      'BODY_TOO_LARGE',
    );
  });

  it('cancels a stream once actual bytes exceed the limit', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_JSON_BODY_BYTES));
        controller.enqueue(new Uint8Array(1));
      },
      cancel,
    });
    await expectSafeAsyncError(() => readBoundedJson(stream), 'BODY_TOO_LARGE');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([new Uint8Array([0xff]), encoder.encode('{invalid json}'), encoder.encode('')])(
    'rejects invalid UTF-8 and malformed JSON without echoing input',
    async (body) => {
      await expectSafeAsyncError(() => readBoundedJson(new Blob([body]).stream()), 'BODY_INVALID');
    },
  );
});

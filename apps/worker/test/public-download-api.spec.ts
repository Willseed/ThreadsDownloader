import { describe, expect, it, vi } from 'vitest';

import { SESSION_COOKIE_NAME } from '../src/security/browser-session.js';
import {
  createOpaqueValueSigner,
  hashIdentifier,
  importSigningKey,
} from '../src/security/cryptography.js';
import {
  DownloadSessionClientError,
  type DownloadSessionMetadataSnapshot,
  type DownloadSessionStatus,
} from '../src/security/download-session-client.js';
import { SessionDownloadAdmissionError } from '../src/security/session-download-admission-client.js';
import { DOWNLOAD_START_DEADLINE_MS } from '../src/security/download-session-state.js';
import { PREVIEW_CAPABILITY_TTL_MS } from '../src/security/preview-capability.js';
import { parseCdnUrl } from '../src/security/upstream-policy.js';
import { DownloadDeliveryError } from '../src/streaming/download-delivery.js';
import { encodeBase64Url } from '../src/utils/base64url.js';
import {
  createPublicDownloadApiHandler,
  type PublicDownloadApiBindings,
  type PublicDownloadApiOperations,
} from '../src/workflows/public-download-api.js';
import {
  DownloadSessionIssuanceError,
  type IssueDownloadSessionInput,
} from '../src/workflows/issue-download-session.js';
import {
  PreviewSessionError,
  type IssuePreviewSessionInput,
} from '../src/workflows/preview-session.js';

const NOW = Date.parse('2026-07-25T00:00:00.000Z');
const EXPECTED_ORIGIN = 'https://threads.example';
const SIGNING_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const REQUEST_ID = 'A'.repeat(32);
const RAW_SESSION_ID = encodeBase64Url(new Uint8Array(32).fill(1));
const CSRF_TOKEN = encodeBase64Url(new Uint8Array(32).fill(2));
const RESOLVE_ID = encodeBase64Url(new Uint8Array(24).fill(3));
const CANDIDATE_ID = encodeBase64Url(new Uint8Array(24).fill(4));
const DOWNLOAD_ID = encodeBase64Url(new Uint8Array(24).fill(5));
const LAST_MODIFIED = 'Mon, 01 Jan 2024 00:00:00 GMT';
const PRIVATE_CDN_URL =
  'https://scontent.cdninstagram.com/o1/v/t16/f2/m69/private.mp4?private_token=secret';
const PREVIEW_CAPABILITY = `v1.${'A'.repeat(16)}.${'A'.repeat(22)}`;

const metadata: DownloadSessionMetadataSnapshot = {
  filename: 'threads_Abcde_1.mp4',
  contentType: 'video/mp4',
  contentLength: 100,
  strongEtag: '"strong-v1"',
  lastModified: LAST_MODIFIED,
  rangeCapability: 'bytes',
};

function status(overrides: Partial<DownloadSessionStatus> = {}): DownloadSessionStatus {
  return {
    status: 'ISSUED',
    available: true,
    startExpiresAt: NOW + DOWNLOAD_START_DEADLINE_MS,
    idleExpiresAt: null,
    absoluteExpiresAt: NOW + 3_600_000,
    completionExpiresAt: null,
    activeStreams: 0,
    ...metadata,
    ...overrides,
  };
}

interface Harness {
  readonly bindings: PublicDownloadApiBindings;
  readonly deliver: ReturnType<typeof vi.fn>;
  readonly handler: (
    request: Request,
    bindings: PublicDownloadApiBindings,
    routingPathname?: string,
  ) => Promise<Response>;
  readonly inspect: ReturnType<typeof vi.fn>;
  readonly issue: ReturnType<typeof vi.fn>;
  readonly issuePreview: ReturnType<typeof vi.fn>;
  readonly openPreview: ReturnType<typeof vi.fn>;
  readonly operationFactory: ReturnType<typeof vi.fn>;
  readonly operations: PublicDownloadApiOperations;
  readonly publicDownloadApi: ReturnType<typeof createPublicDownloadApiHandler>;
  readonly readStatus: ReturnType<typeof vi.fn>;
  readonly requestId: ReturnType<typeof vi.fn>;
}

function createHarness(): Harness {
  const issue = vi.fn(async () => ({
    downloadId: DOWNLOAD_ID,
    startExpiresAt: NOW + DOWNLOAD_START_DEADLINE_MS,
  }));
  const deliver = vi.fn(
    async () =>
      new Response('video', {
        status: 200,
        headers: {
          'accept-ranges': 'bytes',
          'cache-control': 'no-store',
          'content-disposition': `attachment; filename="${metadata.filename}"`,
          'content-length': '5',
          'content-type': 'video/mp4',
          etag: '"strong-v1"',
        },
      }),
  );
  const inspect = vi.fn(async () => metadata);
  const readStatus = vi.fn(async () => status());
  const issuePreview = vi.fn(async () => ({
    capability: PREVIEW_CAPABILITY,
    expiresAt: NOW + PREVIEW_CAPABILITY_TTL_MS,
  }));
  const openPreview = vi.fn(async () => parseCdnUrl(PRIVATE_CDN_URL));
  const operations: PublicDownloadApiOperations = {
    issuer: { issue },
    deliver,
    preview: { issue: issuePreview, open: openPreview },
    inspect,
    status: readStatus,
  };
  const operationFactory = vi.fn(() => operations);
  const requestId = vi.fn(() => REQUEST_ID);
  const bindings: PublicDownloadApiBindings = {
    DOWNLOAD_ENCRYPTION_KEY: 'A'.repeat(43),
    DOWNLOAD_SESSIONS: {} as PublicDownloadApiBindings['DOWNLOAD_SESSIONS'],
    EXPECTED_ORIGIN,
    SESSION_SIGNING_KEY: SIGNING_KEY,
    SESSIONS: {} as PublicDownloadApiBindings['SESSIONS'],
  };
  const publicDownloadApi = createPublicDownloadApiHandler(
    { fetcher: fetch, now: () => NOW, requestId },
    operationFactory,
  );
  const handler: Harness['handler'] = async (
    request,
    requestedBindings,
    routingPathname = new URL(request.url).pathname,
  ) => {
    const response = await publicDownloadApi(request, requestedBindings, routingPathname);
    if (response === null) {
      throw new Error('Expected the test request to belong to the public download workflow.');
    }
    return response;
  };
  return {
    bindings,
    deliver,
    handler,
    inspect,
    issue,
    issuePreview,
    openPreview,
    operationFactory,
    operations,
    publicDownloadApi,
    readStatus,
    requestId,
  };
}

async function signedCookie(): Promise<string> {
  const signer = createOpaqueValueSigner(await importSigningKey(SIGNING_KEY));
  return `${SESSION_COOKIE_NAME}=${await signer.sign(RAW_SESSION_ID)}`;
}

interface RequestOptions {
  readonly body?: unknown;
  readonly contentLength?: string;
  readonly contentType?: string | null;
  readonly cookie?: string | null;
  readonly ifRange?: string;
  readonly method?: string;
  readonly origin?: string | null;
  readonly range?: string;
  readonly rawBody?: string;
}

async function apiRequest(path: string, options: RequestOptions = {}): Promise<Request> {
  const method =
    options.method ??
    (path === '/api/download-sessions' || path === '/api/preview-sessions' ? 'POST' : 'GET');
  const headers = new Headers();
  if (options.cookie !== null) {
    headers.set('cookie', options.cookie ?? (await signedCookie()));
  }
  if (options.origin !== null && method === 'POST') {
    headers.set('origin', options.origin ?? EXPECTED_ORIGIN);
  }
  if (options.contentType !== null && method === 'POST') {
    headers.set('content-type', options.contentType ?? 'application/json');
  }
  if (options.contentLength !== undefined) {
    headers.set('content-length', options.contentLength);
  }
  if (options.range !== undefined) {
    headers.set('range', options.range);
  }
  if (options.ifRange !== undefined) {
    headers.set('if-range', options.ifRange);
  }
  const body =
    method === 'POST'
      ? (options.rawBody ??
        JSON.stringify(
          options.body ?? {
            resolveId: RESOLVE_ID,
            candidateId: CANDIDATE_ID,
            csrfToken: CSRF_TOKEN,
          },
        ))
      : undefined;
  return new Request(`${EXPECTED_ORIGIN}${path}`, { method, headers, body });
}

async function errorBody(response: Response): Promise<{
  readonly error: { readonly code: string; readonly message: string; readonly requestId: string };
}> {
  return response.json() as Promise<{
    readonly error: { readonly code: string; readonly message: string; readonly requestId: string };
  }>;
}

function expectNoOperationCalls(harness: Harness): void {
  expect(harness.issue).not.toHaveBeenCalled();
  expect(harness.deliver).not.toHaveBeenCalled();
  expect(harness.inspect).not.toHaveBeenCalled();
  expect(harness.readStatus).not.toHaveBeenCalled();
  expect(harness.issuePreview).not.toHaveBeenCalled();
  expect(harness.openPreview).not.toHaveBeenCalled();
}

describe('public browser-bound download API', () => {
  it('issues an exact browser-bound relative download response', async () => {
    const harness = createHarness();
    const response = await harness.handler(
      await apiRequest('/api/download-sessions'),
      harness.bindings,
    );

    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      downloadId: DOWNLOAD_ID,
      downloadUrl: `/api/download/${DOWNLOAD_ID}`,
      startExpiresAt: new Date(NOW + DOWNLOAD_START_DEADLINE_MS).toISOString(),
    });
    expect(harness.issue).toHaveBeenCalledTimes(1);
    const input = harness.issue.mock.calls[0]?.[0] as IssueDownloadSessionInput;
    expect(input).toEqual({
      identity: {
        rawId: RAW_SESSION_ID,
        sessionHash: await hashIdentifier(RAW_SESSION_ID),
      },
      csrfHash: await hashIdentifier(CSRF_TOKEN),
      resolveId: RESOLVE_ID,
      candidateId: CANDIDATE_ID,
    });
  });

  it('issues a 20-minute browser-bound preview without exposing the CDN target', async () => {
    const harness = createHarness();
    const response = await harness.handler(
      await apiRequest('/api/preview-sessions'),
      harness.bindings,
    );
    const text = await response.text();

    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(JSON.parse(text)).toEqual({
      previewUrl: `/api/preview/${PREVIEW_CAPABILITY}`,
      expiresAt: new Date(NOW + PREVIEW_CAPABILITY_TTL_MS).toISOString(),
    });
    expect(text).not.toContain(PRIVATE_CDN_URL);
    expect(text).not.toContain('cdninstagram.com');
    expect(harness.issuePreview).toHaveBeenCalledOnce();
    const input = harness.issuePreview.mock.calls[0]?.[0] as IssuePreviewSessionInput;
    expect(input).toEqual({
      identity: {
        rawId: RAW_SESSION_ID,
        sessionHash: await hashIdentifier(RAW_SESSION_ID),
      },
      csrfHash: await hashIdentifier(CSRF_TOKEN),
      resolveId: RESOLVE_ID,
      candidateId: CANDIDATE_ID,
    });
  });

  it('rejects a caller-supplied preview target before capability issuance', async () => {
    const harness = createHarness();
    const response = await harness.handler(
      await apiRequest('/api/preview-sessions', {
        body: {
          resolveId: RESOLVE_ID,
          candidateId: CANDIDATE_ID,
          csrfToken: CSRF_TOKEN,
          finalUrl: PRIVATE_CDN_URL,
        },
      }),
      harness.bindings,
    );
    const text = await response.text();

    expect(response.status).toBe(400);
    expect(text).not.toContain(PRIVATE_CDN_URL);
    expect(harness.issuePreview).not.toHaveBeenCalled();
    expect(harness.openPreview).not.toHaveBeenCalled();
  });

  it('redirects an authorized preview with no-store and no response body', async () => {
    const harness = createHarness();
    const response = await harness.handler(
      await apiRequest(`/api/preview/${PREVIEW_CAPABILITY}`),
      harness.bindings,
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('location')).toBe(PRIVATE_CDN_URL);
    expect(response.body).toBeNull();
    expect(harness.openPreview).toHaveBeenCalledWith({
      capability: PREVIEW_CAPABILITY,
      sessionHash: await hashIdentifier(RAW_SESSION_ID),
    });
    expect(harness.deliver).not.toHaveBeenCalled();
  });

  it('keeps preview target details out of capability failures', async () => {
    const harness = createHarness();
    harness.openPreview.mockRejectedValueOnce(new PreviewSessionError('PREVIEW_SESSION_EXPIRED'));
    const response = await harness.handler(
      await apiRequest(`/api/preview/${PREVIEW_CAPABILITY}`),
      harness.bindings,
    );
    const text = await response.text();

    expect(response.status).toBe(410);
    expect(text).not.toContain(PRIVATE_CDN_URL);
    expect(text).not.toContain('cdninstagram.com');
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'DOWNLOAD_EXPIRED' } });
  });

  it.each([
    ['wrong origin', { origin: 'https://attacker.example' }],
    ['missing origin', { origin: null }],
    ['wrong content type', { contentType: 'text/plain' }],
    ['malformed JSON', { rawBody: '{' }],
    [
      'extra key',
      {
        body: {
          resolveId: RESOLVE_ID,
          candidateId: CANDIDATE_ID,
          csrfToken: CSRF_TOKEN,
          extra: true,
        },
      },
    ],
    [
      'invalid resolve ID',
      { body: { resolveId: 'x', candidateId: CANDIDATE_ID, csrfToken: CSRF_TOKEN } },
    ],
    [
      'invalid candidate ID',
      { body: { resolveId: RESOLVE_ID, candidateId: 'x', csrfToken: CSRF_TOKEN } },
    ],
    [
      'invalid CSRF token',
      { body: { resolveId: RESOLVE_ID, candidateId: CANDIDATE_ID, csrfToken: 'x' } },
    ],
    ['declared length mismatch', { contentLength: '1' }],
  ] as const)('rejects %s before any owned operation', async (_name, options) => {
    const harness = createHarness();
    const response = await harness.handler(
      await apiRequest('/api/download-sessions', options),
      harness.bindings,
    );

    expect(response.status).toBe(400);
    await expect(errorBody(response)).resolves.toMatchObject({
      error: { code: 'REQUEST_INVALID', requestId: REQUEST_ID },
    });
    expectNoOperationCalls(harness);
  });

  it.each([
    ['declared oversize', { contentLength: '16385', rawBody: '{}' }],
    ['actual oversize', { rawBody: ' '.repeat(16_385) }],
  ] as const)('rejects %s with 413 before any owned operation', async (_name, options) => {
    const harness = createHarness();
    const response = await harness.handler(
      await apiRequest('/api/download-sessions', options),
      harness.bindings,
    );

    expect(response.status).toBe(413);
    await expect(errorBody(response)).resolves.toMatchObject({
      error: { code: 'REQUEST_TOO_LARGE', requestId: REQUEST_ID },
    });
    expectNoOperationCalls(harness);
  });

  it.each([
    ['missing', null],
    ['tampered', `${SESSION_COOKIE_NAME}=tampered.signature`],
    ['duplicate', `${SESSION_COOKIE_NAME}=first.value; ${SESSION_COOKIE_NAME}=second.value`],
    ['oversized', `padding=${'a'.repeat(4097)}`],
  ])('rejects a %s session cookie before issuing', async (_name, cookie) => {
    const harness = createHarness();
    const response = await harness.handler(
      await apiRequest('/api/download-sessions', { cookie }),
      harness.bindings,
    );

    expect(response.status).toBe(401);
    await expect(errorBody(response)).resolves.toMatchObject({
      error: { code: 'SESSION_INVALID', requestId: REQUEST_ID },
    });
    expectNoOperationCalls(harness);
  });

  it.each([
    [
      new DownloadSessionIssuanceError('DOWNLOAD_CANDIDATE_UNAVAILABLE', 410),
      410,
      'DOWNLOAD_EXPIRED',
    ],
    [
      new DownloadSessionIssuanceError('DOWNLOAD_ISSUANCE_REQUEST_INVALID', 400),
      400,
      'REQUEST_INVALID',
    ],
    [new DownloadSessionIssuanceError('SESSION_INVALID', 401), 401, 'SESSION_INVALID'],
    [
      new DownloadSessionIssuanceError('DOWNLOAD_SESSION_UNAVAILABLE', 503),
      503,
      'DOWNLOAD_UNAVAILABLE',
    ],
  ] as const)(
    'maps issuance failures without leaking internals',
    async (error, statusCode, code) => {
      const harness = createHarness();
      harness.issue.mockRejectedValueOnce(error);
      const response = await harness.handler(
        await apiRequest('/api/download-sessions'),
        harness.bindings,
      );
      const body = await response.text();

      expect(response.status).toBe(statusCode);
      expect(JSON.parse(body)).toMatchObject({ error: { code, requestId: REQUEST_ID } });
      expect(body).not.toContain(RAW_SESSION_ID);
      expect(body).not.toContain(RESOLVE_ID);
      expect(body).not.toContain(CANDIDATE_ID);
    },
  );

  it.each([
    { downloadId: 'not-canonical', startExpiresAt: NOW + DOWNLOAD_START_DEADLINE_MS },
    { downloadId: DOWNLOAD_ID, startExpiresAt: Number.MAX_SAFE_INTEGER },
  ])('fails closed on an invalid issuance result', async (issued) => {
    const harness = createHarness();
    harness.issue.mockResolvedValueOnce(issued);
    const response = await harness.handler(
      await apiRequest('/api/download-sessions'),
      harness.bindings,
    );

    expect(response.status).toBe(503);
    await expect(errorBody(response)).resolves.toMatchObject({
      error: { code: 'DOWNLOAD_UNAVAILABLE', requestId: REQUEST_ID },
    });
  });

  it('passes range headers and preserves a streaming delivery response without buffering', async () => {
    const harness = createHarness();
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled += 1;
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const delivered = new Response(body, {
      status: 206,
      headers: {
        'accept-ranges': 'bytes',
        'cache-control': 'public, max-age=3600',
        'content-disposition': `attachment; filename="${metadata.filename}"`,
        'content-length': '3',
        'content-range': 'bytes 10-12/100',
        'content-type': 'video/mp4',
        etag: '"strong-v1"',
      },
    });
    harness.deliver.mockResolvedValueOnce(delivered);
    const response = await harness.handler(
      await apiRequest(`/api/download/${DOWNLOAD_ID}`, {
        range: 'bytes=10-12',
        ifRange: '"strong-v1"',
      }),
      harness.bindings,
    );

    expect(response).not.toBe(delivered);
    expect(response.body).toBe(body);
    expect(pulled).toBe(0);
    expect(response.status).toBe(206);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-range')).toBe('bytes 10-12/100');
    expect(harness.deliver).toHaveBeenCalledWith({
      session: {
        rawId: RAW_SESSION_ID,
        sessionHash: await hashIdentifier(RAW_SESSION_ID),
      },
      downloadId: DOWNLOAD_ID,
      rangeHeader: 'bytes=10-12',
      ifRangeHeader: '"strong-v1"',
    });
    await expect(response.arrayBuffer()).resolves.toHaveProperty('byteLength', 3);
  });

  it('delivers a full GET with absent range headers and browser session binding', async () => {
    const harness = createHarness();
    const response = await harness.handler(
      await apiRequest(`/api/download/${DOWNLOAD_ID}`),
      harness.bindings,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(harness.deliver).toHaveBeenCalledWith({
      session: {
        rawId: RAW_SESSION_ID,
        sessionHash: await hashIdentifier(RAW_SESSION_ID),
      },
      downloadId: DOWNLOAD_ID,
      rangeHeader: null,
      ifRangeHeader: null,
    });
  });

  it('preserves a transport-fallback Location with an empty response body', async () => {
    const harness = createHarness();
    harness.deliver.mockResolvedValueOnce(
      new Response(null, {
        status: 307,
        headers: { 'cache-control': 'no-store', location: PRIVATE_CDN_URL },
      }),
    );

    const response = await harness.handler(
      await apiRequest(`/api/download/${DOWNLOAD_ID}`),
      harness.bindings,
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(PRIVATE_CDN_URL);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('');
  });

  it.each([
    [new DownloadSessionClientError('DOWNLOAD_SESSION_UNAUTHORIZED', 401), 401, 'SESSION_INVALID'],
    [new DownloadSessionClientError('DOWNLOAD_SESSION_EXPIRED', 410), 410, 'DOWNLOAD_EXPIRED'],
    [
      new DownloadSessionClientError('DOWNLOAD_SESSION_CONCURRENT_LIMIT', 429),
      429,
      'DOWNLOAD_CONCURRENT_LIMIT',
    ],
    [
      new SessionDownloadAdmissionError('SESSION_DOWNLOAD_LIMIT', 429),
      429,
      'DOWNLOAD_CONCURRENT_LIMIT',
    ],
    [new DownloadDeliveryError('DOWNLOAD_ORIGIN_INVALID'), 502, 'DOWNLOAD_UPSTREAM_UNAVAILABLE'],
    [
      new DownloadDeliveryError('DOWNLOAD_ORIGIN_UNAVAILABLE'),
      502,
      'DOWNLOAD_UPSTREAM_UNAVAILABLE',
    ],
    [
      new DownloadSessionClientError('DOWNLOAD_SESSION_UNAVAILABLE', 503),
      503,
      'DOWNLOAD_UNAVAILABLE',
    ],
    [new Error('private upstream detail'), 500, 'INTERNAL_ERROR'],
  ] as const)('maps delivery failures to fixed public errors', async (error, statusCode, code) => {
    const harness = createHarness();
    harness.deliver.mockRejectedValueOnce(error);
    const response = await harness.handler(
      await apiRequest(`/api/download/${DOWNLOAD_ID}`),
      harness.bindings,
    );
    const body = await response.text();

    expect(response.status).toBe(statusCode);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(JSON.parse(body)).toMatchObject({ error: { code, requestId: REQUEST_ID } });
    expect(body).not.toContain('private upstream detail');
    expect(body).not.toContain(DOWNLOAD_ID);
  });

  it('forwards only a canonical unsatisfied Content-Range on a 416 response', async () => {
    const harness = createHarness();
    harness.deliver.mockRejectedValueOnce(
      new DownloadSessionClientError('DOWNLOAD_SESSION_RANGE_UNAVAILABLE', 416, 'bytes */100'),
    );
    const response = await harness.handler(
      await apiRequest(`/api/download/${DOWNLOAD_ID}`),
      harness.bindings,
    );
    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe('bytes */100');
    await expect(errorBody(response)).resolves.toMatchObject({
      error: { code: 'DOWNLOAD_RANGE_UNAVAILABLE' },
    });

    harness.deliver.mockRejectedValueOnce(
      new DownloadSessionClientError(
        'DOWNLOAD_SESSION_RANGE_UNAVAILABLE',
        416,
        'bytes */100\r\nx-private: secret',
      ),
    );
    const unsafe = await harness.handler(
      await apiRequest(`/api/download/${DOWNLOAD_ID}`),
      harness.bindings,
    );
    expect(unsafe.status).toBe(416);
    expect(unsafe.headers.get('content-range')).toBeNull();
  });

  it('handles HEAD through inspect only and ignores range mutation headers', async () => {
    const harness = createHarness();
    const response = await harness.handler(
      await apiRequest(`/api/download/${DOWNLOAD_ID}`, {
        method: 'HEAD',
        range: 'bytes=10-19',
        ifRange: '"strong-v1"',
      }),
      harness.bindings,
    );

    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="${metadata.filename}"`,
    );
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(response.headers.get('content-length')).toBe('100');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('etag')).toBe('"strong-v1"');
    expect(response.headers.get('last-modified')).toBe(LAST_MODIFIED);
    expect(harness.inspect).toHaveBeenCalledWith({
      downloadId: DOWNLOAD_ID,
      sessionHash: await hashIdentifier(RAW_SESSION_ID),
    });
    expect(harness.deliver).not.toHaveBeenCalled();
    expect(harness.issue).not.toHaveBeenCalled();
    expect(harness.readStatus).not.toHaveBeenCalled();
  });

  it('omits unknown HEAD range metadata and preserves null bodies for HEAD failures', async () => {
    const harness = createHarness();
    harness.inspect.mockResolvedValueOnce({
      ...metadata,
      contentLength: null,
      strongEtag: null,
      lastModified: null,
      rangeCapability: 'unknown',
    });
    const response = await harness.handler(
      await apiRequest(`/api/download/${DOWNLOAD_ID}`, { method: 'HEAD' }),
      harness.bindings,
    );
    expect(response.body).toBeNull();
    expect(response.headers.get('content-length')).toBeNull();
    expect(response.headers.get('accept-ranges')).toBeNull();
    expect(response.headers.get('etag')).toBeNull();

    harness.inspect.mockRejectedValueOnce(
      new DownloadSessionClientError('DOWNLOAD_SESSION_EXPIRED', 410),
    );
    const expired = await harness.handler(
      await apiRequest(`/api/download/${DOWNLOAD_ID}`, { method: 'HEAD' }),
      harness.bindings,
    );
    expect(expired.status).toBe(410);
    expect(expired.body).toBeNull();
    expect(expired.headers.get('cache-control')).toBe('no-store');
  });

  it.each([
    [
      'ISSUED',
      { status: 'ISSUED', idleExpiresAt: null, completionExpiresAt: null, activeStreams: 0 },
    ],
    [
      'ACTIVE',
      {
        status: 'ACTIVE',
        idleExpiresAt: NOW + 600_000,
        completionExpiresAt: null,
        activeStreams: 1,
      },
    ],
    [
      'INTERRUPTED',
      {
        status: 'INTERRUPTED',
        idleExpiresAt: NOW + 600_000,
        completionExpiresAt: null,
        activeStreams: 0,
      },
    ],
    [
      'COMPLETE_PENDING',
      {
        status: 'COMPLETE_PENDING',
        idleExpiresAt: NOW + 600_000,
        completionExpiresAt: NOW + 300_000,
        activeStreams: 0,
      },
    ],
  ] as const)('projects %s status without internal fields', async (_name, overrides) => {
    const harness = createHarness();
    harness.readStatus.mockResolvedValueOnce(status(overrides));
    const response = await harness.handler(
      await apiRequest(`/api/download-status/${DOWNLOAD_ID}`),
      harness.bindings,
    );
    const text = await response.text();
    const body = JSON.parse(text) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(body).toMatchObject({
      available: true,
      status: overrides.status,
      activeStreams: overrides.activeStreams,
      metadata: {
        filename: metadata.filename,
        contentType: metadata.contentType,
        contentLength: metadata.contentLength,
        rangeCapability: metadata.rangeCapability,
      },
    });
    for (const privateName of [
      'strongEtag',
      'lastModified',
      'sessionHash',
      'shortcode',
      'holderId',
      'sequence',
      'ranges',
      'cdninstagram',
    ]) {
      expect(text).not.toContain(privateName);
    }
    expect(harness.inspect).not.toHaveBeenCalled();
    expect(harness.deliver).not.toHaveBeenCalled();
  });

  it('fails closed when status cannot be projected to the public contract', async () => {
    const harness = createHarness();
    harness.readStatus.mockResolvedValueOnce(
      status({ status: 'ACTIVE', idleExpiresAt: null, activeStreams: 1 }),
    );
    const response = await harness.handler(
      await apiRequest(`/api/download-status/${DOWNLOAD_ID}`),
      harness.bindings,
    );
    expect(response.status).toBe(503);
    await expect(errorBody(response)).resolves.toMatchObject({
      error: { code: 'DOWNLOAD_UNAVAILABLE', requestId: REQUEST_ID },
    });
  });

  it.each([
    [`/api/download/${DOWNLOAD_ID}?debug=1`, 'GET', `/api/download/${DOWNLOAD_ID}`],
    [
      `/api/download/%${DOWNLOAD_ID.charCodeAt(0).toString(16)}${DOWNLOAD_ID.slice(1)}`,
      'GET',
      `/api/download/${DOWNLOAD_ID}`,
    ],
    [
      `/api/download/A%2F${DOWNLOAD_ID.slice(3)}`,
      'GET',
      `/api/download/A%2F${DOWNLOAD_ID.slice(3)}`,
    ],
    [`/api/download-status/${DOWNLOAD_ID}?debug=1`, 'GET', `/api/download-status/${DOWNLOAD_ID}`],
    [`/api/preview/${PREVIEW_CAPABILITY}?debug=1`, 'GET', `/api/preview/${PREVIEW_CAPABILITY}`],
    ['/api/preview/not-a-capability', 'GET', '/api/preview/not-a-capability'],
    ['/api/download-sessions?debug=1', 'POST', '/api/download-sessions'],
    ['/api/%64ownload-sessions', 'POST', '/api/download-sessions'],
    ['/%61pi/preview-sessions', 'POST', '/api/preview-sessions'],
    [`/api/%64ownload/${DOWNLOAD_ID}`, 'GET', `/api/download/${DOWNLOAD_ID}`],
    [`/%61pi/download/${DOWNLOAD_ID}`, 'GET', `/api/download/${DOWNLOAD_ID}`],
  ] as const)(
    'owns a normalized family but rejects its non-canonical raw operation: %s %s',
    async (path, method, routingPathname) => {
      const harness = createHarness();
      const response = await harness.handler(
        await apiRequest(path, { method }),
        harness.bindings,
        routingPathname,
      );
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toBe('application/json; charset=UTF-8');
      await expect(errorBody(response)).resolves.toMatchObject({
        error: { code: 'NOT_FOUND', requestId: REQUEST_ID },
      });
      expect(harness.requestId).toHaveBeenCalledOnce();
      expect(harness.operationFactory).not.toHaveBeenCalled();
      expectNoOperationCalls(harness);
    },
  );

  it.each([
    [`/api/preview/${PREVIEW_CAPABILITY}`, `/api/preview/${PREVIEW_CAPABILITY}`],
    [`/api/download-status/${DOWNLOAD_ID}`, `/api/download-status/${DOWNLOAD_ID}`],
  ])('keeps an owned non-download HEAD route bodyless: %s', async (path, routingPathname) => {
    const harness = createHarness();
    const response = await harness.handler(
      await apiRequest(path, { method: 'HEAD' }),
      harness.bindings,
      routingPathname,
    );

    expect(response.status).toBe(404);
    expect(response.body).toBeNull();
    expect(response.headers.get('content-type')).toBe('application/json; charset=UTF-8');
    expect(harness.requestId).toHaveBeenCalledOnce();
    expect(harness.operationFactory).not.toHaveBeenCalled();
    expectNoOperationCalls(harness);
  });

  it.each([
    [`/api/download/${DOWNLOAD_ID}/`, 'GET'],
    [`/api/download/${DOWNLOAD_ID}/extra`, 'GET'],
    ['/api/download/', 'GET'],
    [`/api/download-status/${DOWNLOAD_ID}/`, 'GET'],
    ['/api/missing', 'GET'],
    ['/api/missing', 'HEAD'],
    [`/api/download/${DOWNLOAD_ID}`, 'DELETE'],
    ['/api/download-sessions', 'GET'],
  ] as const)('leaves a generic API route outside the workflow: %s %s', async (path, method) => {
    const harness = createHarness();
    const request = await apiRequest(path, { method });
    const response = await harness.publicDownloadApi(
      request,
      harness.bindings,
      new URL(request.url).pathname,
    );

    expect(response).toBeNull();
    expect(harness.requestId).not.toHaveBeenCalled();
    expect(harness.operationFactory).not.toHaveBeenCalled();
    expectNoOperationCalls(harness);
  });
});

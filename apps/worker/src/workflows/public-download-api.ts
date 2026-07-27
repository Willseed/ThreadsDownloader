import {
  createApiError,
  decodeDownloadSessionRequest,
  decodeDownloadSessionResponse,
  decodeDownloadStatusResponse,
  decodePreviewSessionRequest,
  decodePreviewSessionResponse,
  type ApiErrorCode,
  type DownloadSessionResponse,
  type DownloadStatusResponse,
  type PreviewSessionResponse,
} from '@threads-downloader/contracts';

import {
  BrowserSessionError,
  readBoundedJson,
  resumeBrowserSession,
  validateMutationHeaders,
} from '../security/browser-session.js';
import {
  createOpaqueValueSigner,
  hashIdentifier,
  importSigningKey,
} from '../security/cryptography.js';
import {
  DownloadSessionClientError,
  inspectDownloadSession,
  readDownloadSessionStatus,
  type DownloadSessionMetadataSnapshot,
  type DownloadSessionNamespace,
  type DownloadSessionStatus,
} from '../security/download-session-client.js';
import { isCanonicalPreviewCapability } from '../security/preview-capability.js';
import {
  createSessionDownloadAdmissionPort,
  SessionDownloadAdmissionError,
} from '../security/session-download-admission-client.js';
import type { BrowserSessionIdentity, SessionNamespace } from '../security/session-client.js';
import {
  createDownloadDelivery,
  DownloadDeliveryError,
  type DownloadDelivery,
} from '../streaming/download-delivery.js';
import { decodeBase64Url } from '../utils/base64url.js';
import {
  createRemoteDownloadSessionIssuer,
  DownloadSessionIssuanceError,
  type DownloadSessionIssuer,
} from './issue-download-session.js';
import {
  createRemotePreviewSessionService,
  PreviewSessionError,
  type PreviewSessionService,
} from './preview-session.js';

const DOWNLOAD_ID_BYTES = 24;
const DOWNLOAD_ID_CHARACTERS = 32;
const DOWNLOAD_PATH_PREFIX = '/api/download/';
const DOWNLOAD_STATUS_PATH_PREFIX = '/api/download-status/';
const PREVIEW_PATH_PREFIX = '/api/preview/';

export interface PublicDownloadApiBindings {
  readonly DOWNLOAD_ENCRYPTION_KEY: string;
  readonly DOWNLOAD_SESSIONS: DownloadSessionNamespace;
  readonly EXPECTED_ORIGIN: string;
  readonly SESSION_SIGNING_KEY: string;
  readonly SESSIONS: SessionNamespace;
}

export interface PublicDownloadApiOperations {
  readonly issuer: DownloadSessionIssuer;
  readonly deliver: DownloadDelivery;
  readonly preview: PreviewSessionService;
  inspect(input: {
    readonly downloadId: string;
    readonly sessionHash: string;
  }): Promise<DownloadSessionMetadataSnapshot>;
  status(input: {
    readonly downloadId: string;
    readonly sessionHash: string;
  }): Promise<DownloadSessionStatus>;
}

export interface PublicDownloadApiRuntime {
  readonly fetcher: (request: Request) => Promise<Response>;
  readonly now: () => number;
  readonly requestId: () => string;
}

export type PublicDownloadApiOperationFactory = (
  bindings: PublicDownloadApiBindings,
  runtime: PublicDownloadApiRuntime,
) => PublicDownloadApiOperations;

export type PublicDownloadApiHandler = (
  request: Request,
  bindings: PublicDownloadApiBindings,
) => Promise<Response>;

type PublicRoute =
  | { readonly kind: 'issue' }
  | { readonly kind: 'issue-preview' }
  | { readonly kind: 'preview'; readonly capability: string }
  | { readonly kind: 'download'; readonly downloadId: string }
  | { readonly kind: 'inspect'; readonly downloadId: string }
  | { readonly kind: 'status'; readonly downloadId: string }
  | { readonly kind: 'not-found'; readonly owner: 'download-route' | 'api-fallback' };

interface PublicFailure {
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly status: number;
  readonly contentRange?: string;
}

function failure(code: ApiErrorCode, status: number, message: string): PublicFailure {
  return { code, status, message };
}

function isCanonicalDownloadId(value: string): boolean {
  if (value.length !== DOWNLOAD_ID_CHARACTERS) {
    return false;
  }
  try {
    return decodeBase64Url(value).byteLength === DOWNLOAD_ID_BYTES;
  } catch {
    return false;
  }
}

function singlePathSegment(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) {
    return null;
  }
  const segment = pathname.slice(prefix.length);
  return segment !== '' && !segment.includes('/') ? segment : null;
}

function postRoute(pathname: string, hasQuery: boolean): PublicRoute {
  if (pathname === '/api/download-sessions') {
    return hasQuery ? { kind: 'not-found', owner: 'download-route' } : { kind: 'issue' };
  }
  if (pathname === '/api/preview-sessions') {
    return hasQuery ? { kind: 'not-found', owner: 'download-route' } : { kind: 'issue-preview' };
  }
  return { kind: 'not-found', owner: 'api-fallback' };
}

function readRoute(method: 'GET' | 'HEAD', pathname: string, hasQuery: boolean): PublicRoute {
  const capability = singlePathSegment(pathname, PREVIEW_PATH_PREFIX);
  if (capability !== null) {
    if (method === 'GET' && !hasQuery && isCanonicalPreviewCapability(capability)) {
      return { kind: 'preview', capability };
    }
    return { kind: 'not-found', owner: 'download-route' };
  }
  const downloadId = singlePathSegment(pathname, DOWNLOAD_PATH_PREFIX);
  if (downloadId !== null) {
    if (!hasQuery && isCanonicalDownloadId(downloadId)) {
      return { kind: method === 'HEAD' ? 'inspect' : 'download', downloadId };
    }
    return { kind: 'not-found', owner: 'download-route' };
  }
  const statusDownloadId = singlePathSegment(pathname, DOWNLOAD_STATUS_PATH_PREFIX);
  if (statusDownloadId !== null) {
    if (method === 'GET' && !hasQuery && isCanonicalDownloadId(statusDownloadId)) {
      return { kind: 'status', downloadId: statusDownloadId };
    }
    return { kind: 'not-found', owner: 'download-route' };
  }
  return { kind: 'not-found', owner: 'api-fallback' };
}

function publicRoute(request: Request): PublicRoute {
  const url = new URL(request.url);
  if (request.method === 'POST') {
    return postRoute(url.pathname, url.search !== '');
  }
  if (request.method === 'GET' || request.method === 'HEAD') {
    return readRoute(request.method, url.pathname, url.search !== '');
  }
  return { kind: 'not-found', owner: 'api-fallback' };
}

function browserFailure(error: BrowserSessionError): PublicFailure {
  if (error.code === 'SESSION_COOKIE_INVALID') {
    return failure('SESSION_INVALID', 401, '工作階段無效，請重新載入頁面。');
  }
  if (error.code === 'BODY_TOO_LARGE') {
    return failure('REQUEST_TOO_LARGE', 413, '請求內容超過大小限制。');
  }
  if (error.code === 'SESSION_OPERATION_FAILED') {
    return failure('INTERNAL_ERROR', 500, '伺服器暫時無法處理請求。');
  }
  return failure('REQUEST_INVALID', 400, '請求格式不正確。');
}

function issuanceFailure(error: DownloadSessionIssuanceError): PublicFailure {
  switch (error.code) {
    case 'DOWNLOAD_CANDIDATE_UNAVAILABLE':
      return failure('DOWNLOAD_EXPIRED', 410, '下載候選已過期，請重新解析貼文。');
    case 'DOWNLOAD_ISSUANCE_REQUEST_INVALID':
      return failure('REQUEST_INVALID', 400, '請求格式不正確。');
    case 'SESSION_INVALID':
      return failure('SESSION_INVALID', 401, '工作階段無效，請重新載入頁面。');
    default:
      return failure('DOWNLOAD_UNAVAILABLE', 503, '暫時無法建立下載，請稍後再試。');
  }
}

function clientFailure(error: DownloadSessionClientError): PublicFailure {
  switch (error.code) {
    case 'DOWNLOAD_SESSION_REQUEST_INVALID':
      return failure('REQUEST_INVALID', 400, '請求格式不正確。');
    case 'DOWNLOAD_SESSION_UNAUTHORIZED':
      return failure('SESSION_INVALID', 401, '工作階段無效，請重新載入頁面。');
    case 'DOWNLOAD_SESSION_EXPIRED':
      return failure('DOWNLOAD_EXPIRED', 410, '下載工作階段已過期，請重新建立下載。');
    case 'DOWNLOAD_SESSION_CONCURRENT_LIMIT':
      return failure('DOWNLOAD_CONCURRENT_LIMIT', 429, '同時下載數量已達上限，請稍後再試。');
    case 'DOWNLOAD_SESSION_RANGE_UNAVAILABLE': {
      const mapped = failure('DOWNLOAD_RANGE_UNAVAILABLE', 416, '無法提供要求的下載範圍。');
      const contentRange = safeUnsatisfiedContentRange(error.contentRange);
      return contentRange === null ? mapped : { ...mapped, contentRange };
    }
    default:
      return failure('DOWNLOAD_UNAVAILABLE', 503, '下載暫時無法使用，請稍後再試。');
  }
}

function previewFailure(error: PreviewSessionError): PublicFailure {
  switch (error.code) {
    case 'PREVIEW_CANDIDATE_UNAVAILABLE':
    case 'PREVIEW_SESSION_EXPIRED':
      return failure('DOWNLOAD_EXPIRED', 410, '下載候選已過期，請重新解析貼文。');
    case 'PREVIEW_REQUEST_INVALID':
      return failure('REQUEST_INVALID', 400, '請求格式不正確。');
    case 'SESSION_INVALID':
      return failure('SESSION_INVALID', 401, '工作階段無效，請重新載入頁面。');
    default:
      return failure('DOWNLOAD_UNAVAILABLE', 503, '下載暫時無法使用，請稍後再試。');
  }
}

function safeUnsatisfiedContentRange(value: string | undefined): string | null {
  const match = /^bytes \*\/([1-9]\d*)$/u.exec(value ?? '');
  if (match === null) {
    return null;
  }
  const total = Number(match[1]);
  return Number.isSafeInteger(total) && String(total) === match[1] ? match[0] : null;
}

function admissionFailure(error: SessionDownloadAdmissionError): PublicFailure {
  switch (error.code) {
    case 'SESSION_DOWNLOAD_REQUEST_INVALID':
      return failure('REQUEST_INVALID', 400, '請求格式不正確。');
    case 'SESSION_INVALID':
      return failure('SESSION_INVALID', 401, '工作階段無效，請重新載入頁面。');
    case 'SESSION_DOWNLOAD_LIMIT':
      return failure('DOWNLOAD_CONCURRENT_LIMIT', 429, '同時下載數量已達上限，請稍後再試。');
    default:
      return failure('DOWNLOAD_UNAVAILABLE', 503, '下載暫時無法使用，請稍後再試。');
  }
}

function publicFailure(error: unknown): PublicFailure {
  if (error instanceof BrowserSessionError) {
    return browserFailure(error);
  }
  if (error instanceof DownloadSessionIssuanceError) {
    return issuanceFailure(error);
  }
  if (error instanceof DownloadSessionClientError) {
    return clientFailure(error);
  }
  if (error instanceof PreviewSessionError) {
    return previewFailure(error);
  }
  if (error instanceof SessionDownloadAdmissionError) {
    return admissionFailure(error);
  }
  if (error instanceof DownloadDeliveryError) {
    return failure('DOWNLOAD_UPSTREAM_UNAVAILABLE', 502, '下載來源暫時無法使用，請稍後再試。');
  }
  return failure('INTERNAL_ERROR', 500, '伺服器暫時無法處理請求。');
}

function errorResponse(error: unknown, requestId: string, head: boolean): Response {
  const mapped = publicFailure(error);
  const headers = new Headers({
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=UTF-8',
  });
  if (mapped.contentRange !== undefined) {
    headers.set('content-range', mapped.contentRange);
  }
  const init = { headers, status: mapped.status };
  return head
    ? new Response(null, init)
    : new Response(JSON.stringify(createApiError(mapped.code, mapped.message, requestId)), init);
}

function notFound(
  requestId: string,
  head: boolean,
  owner: 'download-route' | 'api-fallback',
): Response {
  const headers = new Headers({
    'cache-control': 'no-store',
    'content-type':
      owner === 'download-route' ? 'application/json; charset=UTF-8' : 'application/json',
  });
  return head
    ? new Response(null, { status: 404, headers })
    : new Response(
        JSON.stringify(createApiError('NOT_FOUND', '找不到請求的 API 路徑。', requestId)),
        { status: 404, headers },
      );
}

async function browserIdentity(
  request: Request,
  bindings: PublicDownloadApiBindings,
): Promise<BrowserSessionIdentity> {
  const signingKey = await importSigningKey(bindings.SESSION_SIGNING_KEY);
  return resumeBrowserSession(request.headers.get('cookie'), createOpaqueValueSigner(signingKey));
}

function isoDate(timestamp: number): string | null {
  try {
    const value = new Date(timestamp).toISOString();
    return Date.parse(value) === timestamp ? value : null;
  } catch {
    return null;
  }
}

function ownedUnavailable(): DownloadSessionClientError {
  return new DownloadSessionClientError('DOWNLOAD_SESSION_UNAVAILABLE', 503);
}

async function issueDownload(
  request: Request,
  bindings: PublicDownloadApiBindings,
  operations: PublicDownloadApiOperations,
): Promise<Response> {
  const { contentLength } = validateMutationHeaders(request.headers, bindings.EXPECTED_ORIGIN);
  const body = decodeDownloadSessionRequest(await readBoundedJson(request.body, contentLength));
  if (body === null) {
    throw new BrowserSessionError('BODY_INVALID');
  }
  const identity = await browserIdentity(request, bindings);
  const csrfHash = await hashIdentifier(body.csrfToken);
  const issued = await operations.issuer.issue({
    identity,
    csrfHash,
    resolveId: body.resolveId,
    candidateId: body.candidateId,
  });
  const startExpiresAt = isoDate(issued.startExpiresAt);
  if (startExpiresAt === null) {
    throw ownedUnavailable();
  }
  const response: DownloadSessionResponse = {
    downloadId: issued.downloadId,
    downloadUrl: `${DOWNLOAD_PATH_PREFIX}${issued.downloadId}`,
    startExpiresAt,
  };
  if (decodeDownloadSessionResponse(response) === null) {
    throw ownedUnavailable();
  }
  return Response.json(response, {
    status: 201,
    headers: { 'cache-control': 'no-store' },
  });
}

async function issuePreview(
  request: Request,
  bindings: PublicDownloadApiBindings,
  operations: PublicDownloadApiOperations,
): Promise<Response> {
  const { contentLength } = validateMutationHeaders(request.headers, bindings.EXPECTED_ORIGIN);
  const body = decodePreviewSessionRequest(await readBoundedJson(request.body, contentLength));
  if (body === null) {
    throw new BrowserSessionError('BODY_INVALID');
  }
  const identity = await browserIdentity(request, bindings);
  const issued = await operations.preview.issue({
    identity,
    csrfHash: await hashIdentifier(body.csrfToken),
    resolveId: body.resolveId,
    candidateId: body.candidateId,
  });
  const expiresAt = isoDate(issued.expiresAt);
  if (expiresAt === null) {
    throw new PreviewSessionError('PREVIEW_SESSION_UNAVAILABLE');
  }
  const response: PreviewSessionResponse = {
    previewUrl: `${PREVIEW_PATH_PREFIX}${issued.capability}`,
    expiresAt,
  };
  if (decodePreviewSessionResponse(response) === null) {
    throw new PreviewSessionError('PREVIEW_SESSION_UNAVAILABLE');
  }
  return Response.json(response, { status: 201, headers: { 'cache-control': 'no-store' } });
}

async function redirectPreview(
  identity: BrowserSessionIdentity,
  capability: string,
  operations: PublicDownloadApiOperations,
): Promise<Response> {
  const target = await operations.preview.open({
    capability,
    sessionHash: identity.sessionHash,
  });
  return new Response(null, {
    status: 307,
    headers: {
      'cache-control': 'no-store',
      location: target.url.href,
    },
  });
}

function metadataHeaders(metadata: DownloadSessionMetadataSnapshot): Headers {
  const headers = new Headers({
    'cache-control': 'no-store',
    'content-disposition': `attachment; filename="${metadata.filename}"`,
    'content-type': metadata.contentType,
  });
  if (metadata.contentLength !== null) {
    headers.set('content-length', String(metadata.contentLength));
  }
  if (metadata.rangeCapability === 'bytes') {
    headers.set('accept-ranges', 'bytes');
  } else if (metadata.rangeCapability === 'none') {
    headers.set('accept-ranges', 'none');
  }
  if (metadata.strongEtag !== null) {
    headers.set('etag', metadata.strongEtag);
  }
  if (metadata.lastModified !== null) {
    headers.set('last-modified', metadata.lastModified);
  }
  return headers;
}

function noStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function inspectDownload(
  identity: BrowserSessionIdentity,
  downloadId: string,
  operations: PublicDownloadApiOperations,
): Promise<Response> {
  const metadata = await operations.inspect({ downloadId, sessionHash: identity.sessionHash });
  return new Response(null, { status: 200, headers: metadataHeaders(metadata) });
}

function projectStatus(status: DownloadSessionStatus): DownloadStatusResponse | null {
  const startExpiresAt = isoDate(status.startExpiresAt);
  const absoluteExpiresAt = isoDate(status.absoluteExpiresAt);
  const idleExpiresAt = status.idleExpiresAt === null ? null : isoDate(status.idleExpiresAt);
  const completionExpiresAt =
    status.completionExpiresAt === null ? null : isoDate(status.completionExpiresAt);
  if (
    startExpiresAt === null ||
    absoluteExpiresAt === null ||
    (status.idleExpiresAt !== null && idleExpiresAt === null) ||
    (status.completionExpiresAt !== null && completionExpiresAt === null)
  ) {
    return null;
  }
  const projected: DownloadStatusResponse = {
    available: true,
    status: status.status,
    startExpiresAt,
    idleExpiresAt,
    absoluteExpiresAt,
    completionExpiresAt,
    activeStreams: status.activeStreams,
    metadata: {
      filename: status.filename,
      contentType: status.contentType,
      contentLength: status.contentLength,
      rangeCapability: status.rangeCapability,
    },
  };
  return decodeDownloadStatusResponse(projected);
}

async function statusResponse(
  identity: BrowserSessionIdentity,
  downloadId: string,
  operations: PublicDownloadApiOperations,
): Promise<Response> {
  const projected = projectStatus(
    await operations.status({ downloadId, sessionHash: identity.sessionHash }),
  );
  if (projected === null) {
    throw ownedUnavailable();
  }
  return Response.json(projected, { headers: { 'cache-control': 'no-store' } });
}

function productionOperations(
  bindings: PublicDownloadApiBindings,
  runtime: PublicDownloadApiRuntime,
): PublicDownloadApiOperations {
  return {
    issuer: createRemoteDownloadSessionIssuer({
      sessions: bindings.SESSIONS,
      downloadSessions: bindings.DOWNLOAD_SESSIONS,
    }),
    deliver: createDownloadDelivery({
      fetcher: runtime.fetcher,
      sessions: bindings.DOWNLOAD_SESSIONS,
      admissions: createSessionDownloadAdmissionPort(bindings.SESSIONS, runtime.now),
    }),
    preview: createRemotePreviewSessionService({
      sessions: bindings.SESSIONS,
      encryptionKey: bindings.DOWNLOAD_ENCRYPTION_KEY,
      now: runtime.now,
    }),
    inspect: (input) => inspectDownloadSession(bindings.DOWNLOAD_SESSIONS, input),
    status: (input) => readDownloadSessionStatus(bindings.DOWNLOAD_SESSIONS, input),
  };
}

export function createPublicDownloadApiHandler(
  runtime: PublicDownloadApiRuntime,
  operationFactory: PublicDownloadApiOperationFactory = productionOperations,
): PublicDownloadApiHandler {
  return async (request, bindings): Promise<Response> => {
    const id = runtime.requestId();
    const route = publicRoute(request);
    if (route.kind === 'not-found') {
      return notFound(id, request.method === 'HEAD', route.owner);
    }
    try {
      const operations = operationFactory(bindings, runtime);
      if (route.kind === 'issue') {
        return await issueDownload(request, bindings, operations);
      }
      if (route.kind === 'issue-preview') {
        return await issuePreview(request, bindings, operations);
      }
      const identity = await browserIdentity(request, bindings);
      if (route.kind === 'preview') {
        return await redirectPreview(identity, route.capability, operations);
      }
      if (route.kind === 'inspect') {
        return await inspectDownload(identity, route.downloadId, operations);
      }
      if (route.kind === 'status') {
        return await statusResponse(identity, route.downloadId, operations);
      }
      return noStore(
        await operations.deliver({
          session: identity,
          downloadId: route.downloadId,
          rangeHeader: request.headers.get('range'),
          ifRangeHeader: request.headers.get('if-range'),
        }),
      );
    } catch (error: unknown) {
      return errorResponse(error, id, request.method === 'HEAD');
    }
  };
}

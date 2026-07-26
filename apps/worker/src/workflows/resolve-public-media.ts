import {
  createApiError,
  type ApiErrorCode,
  type ResolveCandidate,
  type ResolveRequest,
  type ResolveResponse,
} from '@threads-downloader/contracts';

import { createMediaProbe, MediaProbeError, type ProbedMedia } from '../resolver/media-probe.js';
import {
  createPublicThreadsMarkupResolver,
  PublicThreadsMarkupResolverError,
} from '../resolver/public-threads-markup.js';
import type { MediaCandidate } from '../resolver/structured-media.js';
import {
  BrowserSessionError,
  CSRF_TOKEN_BYTES,
  readBoundedJson,
  resumeBrowserSession,
  validateMutationHeaders,
} from '../security/browser-session.js';
import { ClientIpError, extractClientIp } from '../security/client-ip.js';
import {
  createOpaqueValueSigner,
  hashIdentifier,
  importSigningKey,
} from '../security/cryptography.js';
import {
  acquireResolveLimits,
  ResolveLimitsError,
  type IpRateLimitNamespace,
  type ResolveLimitsLease,
} from '../security/resolve-limits.js';
import { ResolveVaultError, storeResolvedMediaBatch } from '../security/resolve-vault.js';
import type { BrowserSessionIdentity, SessionNamespace } from '../security/session-client.js';
import {
  TurnstileError,
  verifyTurnstileOnce,
  type TurnstileReplayNamespace,
} from '../security/turnstile.js';
import {
  parseThreadsPostUrl,
  type NormalizedThreadsPost,
  UpstreamPolicyError,
} from '../security/upstream-policy.js';
import { decodeBase64Url } from '../utils/base64url.js';

const MAX_PROBE_CANDIDATES = 8;

export interface ResolvePublicMediaBindings {
  readonly EXPECTED_HOST: string;
  readonly EXPECTED_ORIGIN: string;
  readonly IP_RATE_LIMITS: IpRateLimitNamespace;
  readonly SESSION_SIGNING_KEY: string;
  readonly SESSIONS: SessionNamespace;
  readonly TURNSTILE_REPLAYS: TurnstileReplayNamespace;
  readonly TURNSTILE_SECRET: string;
}

export interface ResolvePublicMediaRuntime {
  readonly fetcher: typeof fetch;
  readonly now: () => number;
  readonly requestId: () => string;
}

export type ResolvePublicMediaHandler = (
  request: Request,
  bindings: ResolvePublicMediaBindings,
) => Promise<Response>;

interface PreparedResolveRequest {
  readonly body: ResolveRequest;
  readonly csrfHash: string;
  readonly identity: BrowserSessionIdentity;
  readonly post: NormalizedThreadsPost;
  readonly signingKey: CryptoKey;
}

interface PublicFailure {
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly status: number;
}

type WorkflowErrorCode = 'MEDIA_NOT_FOUND' | 'RESOLVE_UNAVAILABLE';

class ResolvePublicMediaError extends Error {
  constructor(readonly code: WorkflowErrorCode) {
    super(code);
    this.name = 'ResolvePublicMediaError';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactRequestKeys(value: Record<string, unknown>): boolean {
  return (
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right, 'en'))
      .join(',') === 'csrfToken,postUrl,rightsConfirmed,turnstileToken'
  );
}

function isCanonicalCsrfToken(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    return decodeBase64Url(value).byteLength === CSRF_TOKEN_BYTES;
  } catch {
    return false;
  }
}

function decodeResolveRequest(value: unknown): ResolveRequest | null {
  if (
    !isPlainObject(value) ||
    !hasExactRequestKeys(value) ||
    typeof value['postUrl'] !== 'string' ||
    !isCanonicalCsrfToken(value['csrfToken']) ||
    typeof value['turnstileToken'] !== 'string' ||
    value['rightsConfirmed'] !== true
  ) {
    return null;
  }
  return {
    postUrl: value['postUrl'],
    csrfToken: value['csrfToken'],
    turnstileToken: value['turnstileToken'],
    rightsConfirmed: true,
  };
}

function failure(code: ApiErrorCode, status: number, message: string): PublicFailure {
  return { code, status, message };
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

function limitsFailure(error: ResolveLimitsError): PublicFailure {
  if (error.code === 'SESSION_INVALID') {
    return failure('SESSION_INVALID', 401, '工作階段無效，請重新載入頁面。');
  }
  if (error.code === 'IP_RATE_LIMITED' || error.code === 'SESSION_RATE_LIMITED') {
    return failure('RATE_LIMITED', 429, '操作過於頻繁，請稍後再試。');
  }
  return failure('RESOLVE_UNAVAILABLE', 503, '暫時無法解析此貼文，請稍後再試。');
}

function turnstileFailure(error: TurnstileError): PublicFailure {
  if (error.code === 'TURNSTILE_UNAVAILABLE') {
    return failure('TURNSTILE_UNAVAILABLE', 503, '驗證服務暫時無法使用。');
  }
  return failure('TURNSTILE_INVALID', 403, '驗證失敗，請重新驗證後再試。');
}

function markupFailure(error: PublicThreadsMarkupResolverError): PublicFailure {
  switch (error.code) {
    case 'THREADS_LOGIN_REQUIRED':
      return failure('THREADS_LOGIN_REQUIRED', 422, '此貼文需要登入 Threads 才能存取。');
    case 'THREADS_ACCESS_DENIED':
      return failure('THREADS_ACCESS_DENIED', 403, 'Threads 拒絕存取此貼文。');
    case 'THREADS_RATE_LIMITED':
      return failure('THREADS_RATE_LIMITED', 429, 'Threads 暫時限制存取，請稍後再試。');
    case 'THREADS_BOT_BLOCKED':
      return failure('THREADS_BOT_BLOCKED', 503, 'Threads 暫時阻擋自動存取。');
    case 'THREADS_JAVASCRIPT_REQUIRED':
      return failure('THREADS_JAVASCRIPT_REQUIRED', 422, '此貼文目前需要 JavaScript 才能載入。');
    case 'THREADS_MEDIA_NOT_FOUND':
      return failure('MEDIA_NOT_FOUND', 422, '找不到可下載的影片。');
    default:
      return failure('RESOLVE_UNAVAILABLE', 503, '暫時無法解析此貼文，請稍後再試。');
  }
}

function vaultFailure(error: ResolveVaultError): PublicFailure {
  if (error.code === 'SESSION_INVALID') {
    return failure('SESSION_INVALID', 401, '工作階段無效，請重新載入頁面。');
  }
  if (error.code === 'RESOLVE_VAULT_CAPACITY') {
    return failure('RATE_LIMITED', 429, '操作過於頻繁，請稍後再試。');
  }
  return failure('RESOLVE_UNAVAILABLE', 503, '暫時無法解析此貼文，請稍後再試。');
}

function publicFailure(error: unknown): PublicFailure {
  if (error instanceof BrowserSessionError) {
    return browserFailure(error);
  }
  if (error instanceof UpstreamPolicyError && error.code === 'THREADS_URL_INVALID') {
    return failure('URL_INVALID', 400, '請輸入有效的 Threads 貼文網址。');
  }
  if (error instanceof ResolveLimitsError) {
    return limitsFailure(error);
  }
  if (error instanceof ClientIpError) {
    return failure('RESOLVE_UNAVAILABLE', 503, '暫時無法解析此貼文，請稍後再試。');
  }
  if (error instanceof TurnstileError) {
    return turnstileFailure(error);
  }
  if (error instanceof PublicThreadsMarkupResolverError) {
    return markupFailure(error);
  }
  if (error instanceof ResolveVaultError) {
    return vaultFailure(error);
  }
  if (error instanceof ResolvePublicMediaError) {
    return error.code === 'MEDIA_NOT_FOUND'
      ? failure('MEDIA_NOT_FOUND', 422, '找不到可下載的影片。')
      : failure('RESOLVE_UNAVAILABLE', 503, '暫時無法解析此貼文，請稍後再試。');
  }
  return failure('INTERNAL_ERROR', 500, '伺服器暫時無法處理請求。');
}

function errorResponse(error: unknown, requestId: string): Response {
  const mapped = publicFailure(error);
  return Response.json(createApiError(mapped.code, mapped.message, requestId), {
    status: mapped.status,
    headers: { 'cache-control': 'no-store' },
  });
}

async function prepareRequest(
  request: Request,
  bindings: ResolvePublicMediaBindings,
): Promise<PreparedResolveRequest> {
  const { contentLength } = validateMutationHeaders(request.headers, bindings.EXPECTED_ORIGIN);
  const decoded = decodeResolveRequest(await readBoundedJson(request.body, contentLength));
  if (decoded === null) {
    throw new BrowserSessionError('BODY_INVALID');
  }

  const csrfHash = await hashIdentifier(decoded.csrfToken);
  const signingKey = await importSigningKey(bindings.SESSION_SIGNING_KEY);
  const identity = await resumeBrowserSession(
    request.headers.get('cookie'),
    createOpaqueValueSigner(signingKey),
  );
  const post = parseThreadsPostUrl(decoded.postUrl);
  return { body: decoded, csrfHash, identity, post, signingKey };
}

function transientProbeFailure(error: MediaProbeError): boolean {
  return error.code === 'MEDIA_PROBE_ABORTED' || error.code === 'MEDIA_PROBE_UNAVAILABLE';
}

async function probeCandidates(
  postCandidates: readonly MediaCandidate[],
  runtime: ResolvePublicMediaRuntime,
): Promise<readonly ProbedMedia[]> {
  const probe = createMediaProbe({ fetch: (request) => runtime.fetcher(request) });
  const candidates = postCandidates.slice(0, MAX_PROBE_CANDIDATES);
  const settled = await Promise.allSettled(
    candidates.map((candidate) => probe.probe(candidate.value)),
  );
  const usable: ProbedMedia[] = [];
  const finalUrls = new Set<string>();
  let transientFailure = false;

  for (const result of settled) {
    if (result.status === 'fulfilled') {
      const finalUrl = result.value.finalUrl.url.href;
      if (!finalUrls.has(finalUrl)) {
        finalUrls.add(finalUrl);
        usable.push(result.value);
      }
      continue;
    }
    if (!(result.reason instanceof MediaProbeError)) {
      throw result.reason;
    }
    transientFailure ||= transientProbeFailure(result.reason);
  }

  if (usable.length === 0) {
    throw new ResolvePublicMediaError(transientFailure ? 'RESOLVE_UNAVAILABLE' : 'MEDIA_NOT_FOUND');
  }
  return usable;
}

function safeCandidate(candidate: {
  readonly candidateId: string;
  readonly contentLength?: number;
  readonly filename: string;
}): ResolveCandidate {
  return {
    candidateId: candidate.candidateId,
    filename: candidate.filename,
    ...(candidate.contentLength === undefined ? {} : { contentLength: candidate.contentLength }),
  };
}

async function resolveWithLease(
  prepared: PreparedResolveRequest,
  lease: ResolveLimitsLease,
  bindings: ResolvePublicMediaBindings,
  runtime: ResolvePublicMediaRuntime,
  requestId: string,
  headers: Headers,
): Promise<ResolveResponse> {
  await verifyTurnstileOnce(
    {
      token: prepared.body.turnstileToken,
      remoteIp: extractClientIp(headers),
      idempotencyKey: requestId,
    },
    {
      replays: bindings.TURNSTILE_REPLAYS,
      secret: bindings.TURNSTILE_SECRET,
      expectedHostname: bindings.EXPECTED_HOST,
      fetcher: runtime.fetcher,
      now: runtime.now,
    },
  );

  const markup = await createPublicThreadsMarkupResolver({
    fetch: (request) => runtime.fetcher(request),
  }).resolve(prepared.post);
  const candidates = await probeCandidates(markup.candidates, runtime);
  const stored = await storeResolvedMediaBatch({
    sessions: bindings.SESSIONS,
    identity: prepared.identity,
    csrfHash: prepared.csrfHash,
    permitId: lease.permitId,
    shortcode: prepared.post.shortcode,
    candidates,
    now: runtime.now(),
    clock: runtime.now,
  });
  return {
    resolveId: stored.resolveId,
    expiresAt: new Date(stored.expiresAt).toISOString(),
    candidates: stored.candidates.map(safeCandidate),
  };
}

export function createResolvePublicMediaHandler(
  runtime: ResolvePublicMediaRuntime,
): ResolvePublicMediaHandler {
  return async (request, bindings): Promise<Response> => {
    const id = runtime.requestId();
    let prepared: PreparedResolveRequest;
    try {
      prepared = await prepareRequest(request, bindings);
    } catch (error: unknown) {
      return errorResponse(error, id);
    }

    let lease: ResolveLimitsLease;
    try {
      lease = await acquireResolveLimits({
        sessions: bindings.SESSIONS,
        ipRateLimits: bindings.IP_RATE_LIMITS,
        signingKey: prepared.signingKey,
        identity: prepared.identity,
        csrfHash: prepared.csrfHash,
        headers: request.headers,
        now: runtime.now(),
      });
    } catch (error: unknown) {
      return errorResponse(error, id);
    }

    try {
      const response = await resolveWithLease(
        prepared,
        lease,
        bindings,
        runtime,
        id,
        request.headers,
      );
      return Response.json(response, { headers: { 'cache-control': 'no-store' } });
    } catch (error: unknown) {
      return errorResponse(error, id);
    } finally {
      try {
        await lease.release();
      } catch {
        // Permit release is best-effort and must not replace the safe public result.
      }
    }
  };
}

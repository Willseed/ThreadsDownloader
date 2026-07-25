import {
  decideRedirect,
  parseThreadsPostUrl,
  type NormalizedThreadsPost,
  UpstreamPolicyError,
} from '../security/upstream-policy.js';
import { extractMediaCandidates, type MediaCandidate } from './structured-media.js';

const FETCH_TIMEOUT_MS = 8_000;
const MAX_MARKUP_BYTES = 2 * 1024 * 1024;
const HTML_MEDIA_TYPES = new Set(['application/xhtml+xml', 'text/html']);
const CANONICAL_CONTENT_LENGTH = /^(?:0|[1-9]\d*)$/u;

export type PublicThreadsMarkupResolverErrorCode =
  | 'THREADS_ACCESS_DENIED'
  | 'THREADS_BOT_BLOCKED'
  | 'THREADS_JAVASCRIPT_REQUIRED'
  | 'THREADS_LOGIN_REQUIRED'
  | 'THREADS_MEDIA_NOT_FOUND'
  | 'THREADS_RATE_LIMITED'
  | 'THREADS_REDIRECT_INVALID'
  | 'THREADS_REDIRECT_LIMIT'
  | 'THREADS_RESPONSE_INVALID'
  | 'THREADS_RESPONSE_TOO_LARGE'
  | 'THREADS_UPSTREAM_UNAVAILABLE';

export class PublicThreadsMarkupResolverError extends Error {
  constructor(readonly code: PublicThreadsMarkupResolverErrorCode) {
    super(code);
    this.name = 'PublicThreadsMarkupResolverError';
  }
}

export interface ResolvedThreadsMarkup {
  readonly candidates: readonly MediaCandidate[];
}

export interface PublicThreadsMarkupResolver {
  resolve(post: NormalizedThreadsPost): Promise<ResolvedThreadsMarkup>;
}

export type ThreadsMarkupFetch = (request: Request) => Promise<Response>;
export type TimeoutSignalFactory = (milliseconds: number) => AbortSignal;

export interface PublicThreadsMarkupResolverDependencies {
  readonly fetch: ThreadsMarkupFetch;
  readonly timeoutSignal?: TimeoutSignalFactory;
}

function fail(code: PublicThreadsMarkupResolverErrorCode): never {
  throw new PublicThreadsMarkupResolverError(code);
}

function fixedHeaders(): Headers {
  return new Headers({
    accept: 'text/html, application/xhtml+xml;q=0.9',
    'accept-language': 'en-US,en;q=0.8',
    'user-agent': 'ThreadsDownloader/0.1',
  });
}

function createRequest(post: NormalizedThreadsPost, signal: AbortSignal): Request {
  return new Request(post.canonicalUrl, {
    method: 'GET',
    credentials: 'omit',
    headers: fixedHeaders(),
    redirect: 'manual',
    referrer: '',
    referrerPolicy: 'no-referrer',
    signal,
  });
}

function cancelBody(response: Response): void {
  try {
    const cancellation = response.body?.cancel();
    if (cancellation !== undefined) {
      void cancellation.catch(() => undefined);
    }
  } catch {
    // Cancellation is best-effort and must not replace the safe resolver result.
  }
}

function mapRedirectError(error: unknown): never {
  if (error instanceof UpstreamPolicyError && error.code === 'REDIRECT_LIMIT') {
    return fail('THREADS_REDIRECT_LIMIT');
  }
  return fail('THREADS_REDIRECT_INVALID');
}

function statusError(status: number): never {
  if (status === 401) {
    return fail('THREADS_LOGIN_REQUIRED');
  }
  if (status === 403) {
    return fail('THREADS_ACCESS_DENIED');
  }
  if (status === 429) {
    return fail('THREADS_RATE_LIMITED');
  }
  return fail('THREADS_UPSTREAM_UNAVAILABLE');
}

function assertHtmlContentType(response: Response): void {
  const contentType = response.headers.get('content-type');
  if (contentType === null) {
    return fail('THREADS_RESPONSE_INVALID');
  }
  const separator = contentType.indexOf(';');
  const mediaType = contentType.slice(0, separator === -1 ? contentType.length : separator);
  if (!HTML_MEDIA_TYPES.has(mediaType.trim().toLowerCase())) {
    return fail('THREADS_RESPONSE_INVALID');
  }
}

function assertDeclaredLength(response: Response): void {
  const contentLength = response.headers.get('content-length');
  if (contentLength === null) {
    return;
  }
  if (!CANONICAL_CONTENT_LENGTH.test(contentLength)) {
    return fail('THREADS_RESPONSE_INVALID');
  }
  const length = Number(contentLength);
  if (!Number.isSafeInteger(length)) {
    return fail('THREADS_RESPONSE_INVALID');
  }
  if (length > MAX_MARKUP_BYTES) {
    return fail('THREADS_RESPONSE_TOO_LARGE');
  }
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // Cancellation is best-effort and the original safe error is retained.
  }
}

async function readBoundedMarkup(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return fail('THREADS_RESPONSE_INVALID');
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      if (!(result.value instanceof Uint8Array)) {
        cancelReader(reader);
        return fail('THREADS_RESPONSE_INVALID');
      }
      if (result.value.byteLength > MAX_MARKUP_BYTES - total) {
        cancelReader(reader);
        return fail('THREADS_RESPONSE_TOO_LARGE');
      }
      chunks.push(result.value.slice());
      total += result.value.byteLength;
    }
  } catch (error: unknown) {
    cancelReader(reader);
    if (error instanceof PublicThreadsMarkupResolverError) {
      throw error;
    }
    return fail('THREADS_UPSTREAM_UNAVAILABLE');
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return fail('THREADS_RESPONSE_INVALID');
  }
}

function includesAny(value: string, markers: readonly string[]): boolean {
  return markers.some((marker) => value.includes(marker));
}

function classifyEmptyMarkup(markup: string): never {
  const normalized = markup.toLowerCase();
  const hasPasswordInput = includesAny(normalized, [
    'type="password"',
    "type='password'",
    'type=password',
  ]);
  if (
    hasPasswordInput &&
    includesAny(normalized, ['log in', 'login', 'sign in']) &&
    normalized.includes('<form')
  ) {
    return fail('THREADS_LOGIN_REQUIRED');
  }
  if (includesAny(normalized, ['automated behavior', 'temporarily blocked', 'unusual traffic'])) {
    return fail('THREADS_BOT_BLOCKED');
  }
  if (
    normalized.includes('<noscript') &&
    includesAny(normalized, ['enable javascript', 'javascript is required', 'requires javascript'])
  ) {
    return fail('THREADS_JAVASCRIPT_REQUIRED');
  }
  return fail('THREADS_MEDIA_NOT_FOUND');
}

function extractCandidates(markup: string): ResolvedThreadsMarkup {
  let candidates: readonly MediaCandidate[];
  try {
    candidates = extractMediaCandidates(markup);
  } catch {
    return fail('THREADS_RESPONSE_INVALID');
  }
  return candidates.length === 0 ? classifyEmptyMarkup(markup) : { candidates: [...candidates] };
}

function defaultTimeoutSignal(milliseconds: number): AbortSignal {
  return AbortSignal.timeout(milliseconds);
}

export function createPublicThreadsMarkupResolver(
  dependencies: PublicThreadsMarkupResolverDependencies,
): PublicThreadsMarkupResolver {
  const timeoutSignal = dependencies.timeoutSignal ?? defaultTimeoutSignal;
  return {
    async resolve(initialPost: NormalizedThreadsPost): Promise<ResolvedThreadsMarkup> {
      let signal: AbortSignal;
      try {
        signal = timeoutSignal(FETCH_TIMEOUT_MS);
      } catch {
        return fail('THREADS_UPSTREAM_UNAVAILABLE');
      }

      let currentPost = initialPost;
      let redirectCount = 0;
      while (true) {
        let response: Response;
        try {
          response = await dependencies.fetch(createRequest(currentPost, signal));
        } catch {
          return fail('THREADS_UPSTREAM_UNAVAILABLE');
        }

        let redirectedPost: NormalizedThreadsPost | undefined;
        let decision;
        try {
          decision = decideRedirect({
            status: response.status,
            location: response.headers.get('location'),
            currentUrl: currentPost.canonicalUrl,
            redirectCount,
            validateTarget(target) {
              redirectedPost = parseThreadsPostUrl(target);
            },
          });
        } catch (error: unknown) {
          cancelBody(response);
          return mapRedirectError(error);
        }

        if (decision.kind === 'redirect') {
          cancelBody(response);
          currentPost = redirectedPost!;
          redirectCount = decision.redirectCount;
          continue;
        }
        if (response.status !== 200) {
          cancelBody(response);
          return statusError(response.status);
        }

        try {
          assertHtmlContentType(response);
          assertDeclaredLength(response);
        } catch (error: unknown) {
          cancelBody(response);
          if (error instanceof PublicThreadsMarkupResolverError) {
            throw error;
          }
          return fail('THREADS_RESPONSE_INVALID');
        }
        return extractCandidates(await readBoundedMarkup(response));
      }
    },
  };
}

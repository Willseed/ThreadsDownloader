import {
  createProbeTransferPlan,
  inspectRepresentationHeaders,
  type ReliableValidator,
} from '../security/range-transfer.js';
import {
  decideRedirect,
  parseCdnUrl,
  type CdnUrl,
  upstreamHeaders,
  UpstreamPolicyError,
} from '../security/upstream-policy.js';

const MEDIA_PROBE_TIMEOUT_MS = 8_000;
const VIDEO_MEDIA_TYPE = /^video\/[!#$%&'*+.^_`|~A-Za-z0-9-]+$/u;

export type MediaRangeCapability = 'bytes' | 'none' | 'unknown';

export type MediaProbeErrorCode =
  | 'MEDIA_PROBE_ABORTED'
  | 'MEDIA_PROBE_CANDIDATE_INVALID'
  | 'MEDIA_PROBE_CONTENT_TYPE_INVALID'
  | 'MEDIA_PROBE_METADATA_INVALID'
  | 'MEDIA_PROBE_REDIRECT_INVALID'
  | 'MEDIA_PROBE_REDIRECT_LIMIT'
  | 'MEDIA_PROBE_STATUS_INVALID'
  | 'MEDIA_PROBE_UNAVAILABLE';

export class MediaProbeError extends Error {
  constructor(readonly code: MediaProbeErrorCode) {
    super(code);
    this.name = 'MediaProbeError';
  }
}

export interface ProbedMedia {
  readonly finalUrl: CdnUrl;
  readonly contentType: string;
  readonly contentLength: number | null;
  readonly rangeCapability: MediaRangeCapability;
  readonly strongEtag: string | null;
  readonly lastModified: string | null;
  readonly validator: ReliableValidator | null;
  readonly completionReliable: boolean;
  readonly probeMethod: 'head' | 'range-get';
}

export type MediaProbeFetch = (request: Request) => Promise<Response>;
export type MediaProbeTimeoutSignalFactory = (milliseconds: number) => AbortSignal;

export interface MediaProbeDependencies {
  readonly fetch: MediaProbeFetch;
  readonly timeoutSignal?: MediaProbeTimeoutSignalFactory;
}

export interface MediaProbe {
  probe(candidate: CdnUrl): Promise<ProbedMedia>;
}

interface TerminalResponse {
  readonly response: Response;
  readonly finalUrl: CdnUrl;
  readonly redirectCount: number;
}

function fail(code: MediaProbeErrorCode): never {
  throw new MediaProbeError(code);
}

function defaultTimeoutSignal(milliseconds: number): AbortSignal {
  return AbortSignal.timeout(milliseconds);
}

function cancelBody(response: Response): void {
  try {
    const cancellation = response.body?.cancel();
    if (cancellation !== undefined) {
      void cancellation.catch(() => undefined);
    }
  } catch {
    // Cancellation is best-effort and must not replace the safe probe result.
  }
}

function revalidateCandidate(candidate: CdnUrl): CdnUrl {
  try {
    return parseCdnUrl(candidate.url.toString());
  } catch {
    return fail('MEDIA_PROBE_CANDIDATE_INVALID');
  }
}

function createProbeRequest(target: CdnUrl, method: 'GET' | 'HEAD', signal: AbortSignal): Request {
  const headers = upstreamHeaders();
  headers.set('accept-encoding', 'identity');
  if (method === 'GET') {
    headers.set('range', 'bytes=0-0');
  }
  return new Request(target.url.toString(), {
    method,
    credentials: 'omit',
    headers,
    redirect: 'manual',
    referrer: '',
    referrerPolicy: 'no-referrer',
    signal,
  });
}

function isAbortFailure(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) {
    return true;
  }
  if (typeof error !== 'object' || error === null || !('name' in error)) {
    return false;
  }
  return error.name === 'AbortError' || error.name === 'TimeoutError';
}

function mapFetchFailure(error: unknown, signal: AbortSignal): never {
  return fail(isAbortFailure(error, signal) ? 'MEDIA_PROBE_ABORTED' : 'MEDIA_PROBE_UNAVAILABLE');
}

function mapRedirectFailure(error: unknown): never {
  if (error instanceof UpstreamPolicyError && error.code === 'REDIRECT_LIMIT') {
    return fail('MEDIA_PROBE_REDIRECT_LIMIT');
  }
  return fail('MEDIA_PROBE_REDIRECT_INVALID');
}

function hasUnquotedComma(value: string): boolean {
  let quoted = false;
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      escaped = false;
    } else if (quoted && character === '\\') {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && character === ',') {
      return true;
    }
  }
  return false;
}

async function fetchTerminalResponse(
  fetcher: MediaProbeFetch,
  initialUrl: CdnUrl,
  initialRedirectCount: number,
  method: 'GET' | 'HEAD',
  signal: AbortSignal,
): Promise<TerminalResponse> {
  let currentUrl = initialUrl;
  let redirectCount = initialRedirectCount;

  while (true) {
    if (signal.aborted) {
      return fail('MEDIA_PROBE_ABORTED');
    }

    let response: Response;
    try {
      response = await fetcher(createProbeRequest(currentUrl, method, signal));
    } catch (error: unknown) {
      return mapFetchFailure(error, signal);
    }

    let redirectedUrl: CdnUrl | undefined;
    try {
      const decision = decideRedirect({
        status: response.status,
        location: response.headers.get('location'),
        currentUrl: currentUrl.url.toString(),
        redirectCount,
        validateTarget(target) {
          redirectedUrl = parseCdnUrl(target);
        },
      });
      if (decision.kind === 'stop') {
        return { response, finalUrl: currentUrl, redirectCount };
      }

      cancelBody(response);
      if (redirectedUrl === undefined) {
        return fail('MEDIA_PROBE_REDIRECT_INVALID');
      }
      currentUrl = redirectedUrl;
      redirectCount = decision.redirectCount;
    } catch (error: unknown) {
      cancelBody(response);
      return mapRedirectFailure(error);
    }
  }
}

function parseVideoContentType(headers: Headers): string {
  const value = headers.get('content-type');
  if (value === null || hasUnquotedComma(value)) {
    return fail('MEDIA_PROBE_CONTENT_TYPE_INVALID');
  }
  const separator = value.indexOf(';');
  const mediaType = value
    .slice(0, separator === -1 ? value.length : separator)
    .trim()
    .toLowerCase();
  if (mediaType === 'video/*' || !VIDEO_MEDIA_TYPE.test(mediaType)) {
    return fail('MEDIA_PROBE_CONTENT_TYPE_INVALID');
  }
  return mediaType;
}

function assertIdentityEncoding(headers: Headers): void {
  const encoding = headers.get('content-encoding');
  if (encoding !== null && encoding.trim().toLowerCase() !== 'identity') {
    return fail('MEDIA_PROBE_METADATA_INVALID');
  }
}

function advertisedRangeCapability(headers: Headers): MediaRangeCapability {
  const value = headers.get('accept-ranges')?.trim().toLowerCase();
  if (value === 'bytes' || value === 'none') {
    return value;
  }
  return 'unknown';
}

function inspectSuccessfulResponse(
  terminal: TerminalResponse,
  probeMethod: ProbedMedia['probeMethod'],
): ProbedMedia {
  const contentType = parseVideoContentType(terminal.response.headers);
  assertIdentityEncoding(terminal.response.headers);

  let representation;
  let plan;
  try {
    representation = inspectRepresentationHeaders(terminal.response.headers);
    plan = createProbeTransferPlan({
      status: terminal.response.status as 200 | 206,
      headers: terminal.response.headers,
    });
  } catch {
    return fail('MEDIA_PROBE_METADATA_INVALID');
  }
  if (plan.total !== null && plan.total <= 0) {
    return fail('MEDIA_PROBE_METADATA_INVALID');
  }

  let rangeCapability: MediaRangeCapability;
  if (probeMethod === 'head') {
    rangeCapability = advertisedRangeCapability(terminal.response.headers);
  } else {
    rangeCapability = terminal.response.status === 206 ? 'bytes' : 'none';
  }
  return {
    finalUrl: terminal.finalUrl,
    contentType,
    contentLength: plan.total,
    rangeCapability,
    strongEtag: representation.strongEtag?.value ?? null,
    lastModified: representation.lastModified?.value ?? null,
    validator: representation.validator,
    completionReliable: plan.total !== null && plan.total > 0 && plan.validator !== null,
    probeMethod,
  };
}

function createSignal(timeoutSignal: MediaProbeTimeoutSignalFactory): AbortSignal {
  try {
    return timeoutSignal(MEDIA_PROBE_TIMEOUT_MS);
  } catch {
    return fail('MEDIA_PROBE_UNAVAILABLE');
  }
}

export function createMediaProbe(dependencies: MediaProbeDependencies): MediaProbe {
  const timeoutSignal = dependencies.timeoutSignal ?? defaultTimeoutSignal;
  return {
    async probe(candidate: CdnUrl): Promise<ProbedMedia> {
      const initialUrl = revalidateCandidate(candidate);
      const signal = createSignal(timeoutSignal);
      const head = await fetchTerminalResponse(dependencies.fetch, initialUrl, 0, 'HEAD', signal);
      let fallbackUrl: CdnUrl;
      let redirectCount: number;
      try {
        if (head.response.status === 200) {
          return inspectSuccessfulResponse(head, 'head');
        }
        if (head.response.status !== 405 && head.response.status !== 501) {
          return fail('MEDIA_PROBE_STATUS_INVALID');
        }
        fallbackUrl = head.finalUrl;
        redirectCount = head.redirectCount;
      } finally {
        cancelBody(head.response);
      }

      const rangeGet = await fetchTerminalResponse(
        dependencies.fetch,
        fallbackUrl,
        redirectCount,
        'GET',
        signal,
      );
      try {
        if (rangeGet.response.status !== 200 && rangeGet.response.status !== 206) {
          return fail('MEDIA_PROBE_STATUS_INVALID');
        }
        return inspectSuccessfulResponse(rangeGet, 'range-get');
      } finally {
        cancelBody(rangeGet.response);
      }
    },
  };
}

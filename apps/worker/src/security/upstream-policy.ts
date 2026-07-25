const MAX_THREADS_URL_LENGTH = 2048;
const MAX_CDN_URL_LENGTH = 4096;
const MAX_REDIRECTS = 3;

const THREADS_HOSTS = new Set(['threads.com', 'www.threads.com', 'threads.net', 'www.threads.net']);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const THREADS_PATH = /^\/@([A-Za-z0-9._]{1,30})\/post\/([A-Za-z0-9_-]{5,64})\/?$/;

export type UpstreamPolicyErrorCode =
  'CDN_URL_INVALID' | 'REDIRECT_INVALID' | 'REDIRECT_LIMIT' | 'THREADS_URL_INVALID';

export class UpstreamPolicyError extends Error {
  constructor(readonly code: UpstreamPolicyErrorCode) {
    super(code);
    this.name = 'UpstreamPolicyError';
  }
}

export interface ThreadsPostUrl {
  readonly canonicalUrl: string;
  readonly username: string;
  readonly shortcode: string;
}

export interface CdnUrl {
  readonly url: URL;
}

export interface RedirectDecision {
  readonly kind: 'redirect' | 'stop';
  readonly redirectCount: number;
  readonly url?: URL;
}

export interface RedirectInput {
  readonly status: number;
  readonly location: string | null;
  readonly currentUrl: string;
  readonly redirectCount: number;
  readonly validateTarget: (target: string) => unknown;
}

function policyError(code: UpstreamPolicyErrorCode): never {
  throw new UpstreamPolicyError(code);
}

function parseUrl(value: string, maxLength: number, code: UpstreamPolicyErrorCode): URL {
  if (value.length > maxLength) {
    return policyError(code);
  }

  try {
    return new URL(value);
  } catch {
    return policyError(code);
  }
}

function hasOnlyDefaultHttpsPort(url: URL): boolean {
  return url.port === '';
}

function usesLiteralHostname(value: string, url: URL): boolean {
  const authorityStart = value.indexOf('://') + 3;
  const authorityEnd = value.slice(authorityStart).search(/[/?#]/);
  const authority = value.slice(
    authorityStart,
    authorityEnd === -1 ? value.length : authorityStart + authorityEnd,
  );
  const hostWithPort = authority.slice(authority.lastIndexOf('@') + 1);
  const hostname = hostWithPort.startsWith('[')
    ? hostWithPort.slice(0, hostWithPort.indexOf(']') + 1)
    : hostWithPort.split(':', 1)[0]!;

  return hostname.toLowerCase() === url.hostname;
}

export function parseThreadsPostUrl(value: string): ThreadsPostUrl {
  const url = parseUrl(value, MAX_THREADS_URL_LENGTH, 'THREADS_URL_INVALID');
  if (
    url.protocol !== 'https:' ||
    !THREADS_HOSTS.has(url.hostname) ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    !hasOnlyDefaultHttpsPort(url) ||
    /%/i.test(url.pathname)
  ) {
    return policyError('THREADS_URL_INVALID');
  }

  const match = THREADS_PATH.exec(url.pathname);
  if (match === null) {
    return policyError('THREADS_URL_INVALID');
  }

  const username = match[1]!;
  const shortcode = match[2]!;
  return {
    canonicalUrl: `https://www.threads.com/@${username}/post/${shortcode}`,
    username,
    shortcode,
  };
}

export function parseCdnUrl(value: string): CdnUrl {
  const url = parseUrl(value, MAX_CDN_URL_LENGTH, 'CDN_URL_INVALID');
  const hostname = url.hostname.toLowerCase();
  const isCdnHost = hostname === 'cdninstagram.com' || hostname.endsWith('.cdninstagram.com');
  if (
    url.protocol !== 'https:' ||
    !isCdnHost ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    !hasOnlyDefaultHttpsPort(url) ||
    !usesLiteralHostname(value, url)
  ) {
    return policyError('CDN_URL_INVALID');
  }

  return { url };
}

export function decideRedirect(input: RedirectInput): RedirectDecision {
  if (!REDIRECT_STATUSES.has(input.status)) {
    return { kind: 'stop', redirectCount: input.redirectCount };
  }
  if (input.location === null || input.redirectCount >= MAX_REDIRECTS) {
    return policyError(input.location === null ? 'REDIRECT_INVALID' : 'REDIRECT_LIMIT');
  }

  let target: URL;
  try {
    target = new URL(input.location, input.currentUrl);
  } catch {
    return policyError('REDIRECT_INVALID');
  }

  try {
    input.validateTarget(target.toString());
  } catch {
    return policyError('REDIRECT_INVALID');
  }
  return { kind: 'redirect', redirectCount: input.redirectCount + 1, url: target };
}

export function upstreamHeaders(): Headers {
  return new Headers({
    accept: '*/*',
    'user-agent': 'threads-downloader/0.1',
  });
}

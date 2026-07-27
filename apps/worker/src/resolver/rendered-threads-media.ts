import { decodeExactRecord } from '@threads-downloader/contracts/strict-json';

import {
  parseCdnUrl,
  type NormalizedThreadsPost,
  UpstreamPolicyError,
} from '../security/upstream-policy.js';
import { RENDERED_BROWSER_SESSION_BUDGET_MS } from './browser-session-renderer.js';
import type { MediaCandidate, RenderedMediaCandidateSource } from './structured-media.js';

const MAX_IDENTITY_RESULTS = 1;
const MAX_MEDIA_RESULTS = 16;
const MAX_VALUE_LENGTH = 4_096;

export const RENDERED_RESOLVER_BUDGET_MS = RENDERED_BROWSER_SESSION_BUDGET_MS;

export interface RenderedThreadsPagePort {
  render(url: string): Promise<unknown>;
}

export type RenderedThreadsMediaResolverErrorCode =
  'RENDERED_MEDIA_NOT_FOUND' | 'RENDERED_RESPONSE_INVALID' | 'RENDERED_UNAVAILABLE';

export class RenderedThreadsMediaResolverError extends Error {
  constructor(readonly code: RenderedThreadsMediaResolverErrorCode) {
    super(code);
    this.name = 'RenderedThreadsMediaResolverError';
  }
}

export interface ResolvedThreadsMedia {
  readonly candidates: readonly MediaCandidate[];
}

export interface PublicThreadsMediaResolver {
  resolve(post: NormalizedThreadsPost): Promise<ResolvedThreadsMedia>;
}

export interface RenderedThreadsMediaResolverDependencies {
  readonly page: RenderedThreadsPagePort;
}

interface DecodedRenderedPage {
  readonly candidateSources: readonly RenderedMediaCandidateSource[];
  readonly candidateUrls: readonly string[];
  readonly canonicalUrl: string;
  readonly openGraphUrl: string;
}

function fail(code: RenderedThreadsMediaResolverErrorCode): never {
  throw new RenderedThreadsMediaResolverError(code);
}

function renderedMediaUrl(post: NormalizedThreadsPost): string {
  return `${post.canonicalUrl}/media`;
}

function renderedIdentityValues(
  post: NormalizedThreadsPost,
): readonly [canonical: string, usernameRedacted: string] {
  return [post.canonicalUrl, `https://www.threads.com/@/post/${post.shortcode}`];
}

function decodeStringArray(
  value: unknown,
  maximumItems: number,
  maximumLength: number,
): readonly string[] | null {
  if (!Array.isArray(value) || value.length > maximumItems) {
    return null;
  }
  const decoded: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.length > maximumLength) {
      return null;
    }
    decoded.push(item);
  }
  return decoded;
}

function decodeCandidateSources(value: unknown): readonly RenderedMediaCandidateSource[] | null {
  const sources = decodeStringArray(value, MAX_MEDIA_RESULTS, 'rendered-source'.length);
  if (
    sources === null ||
    sources.some((source) => source !== 'rendered-source' && source !== 'rendered-video')
  ) {
    return null;
  }
  return sources as readonly RenderedMediaCandidateSource[];
}

function exactIdentity(value: unknown): string | null {
  const values = decodeStringArray(value, MAX_IDENTITY_RESULTS, MAX_VALUE_LENGTH);
  return values?.length === 1 && values[0]!.length > 0 ? values[0]! : null;
}

function decodeRenderedPage(value: unknown): DecodedRenderedPage {
  const envelope = decodeExactRecord(value, [
    'canonicalUrls',
    'openGraphUrls',
    'candidateSources',
    'candidateUrls',
  ]);
  if (envelope === null) {
    return fail('RENDERED_RESPONSE_INVALID');
  }
  const canonicalUrl = exactIdentity(envelope['canonicalUrls']);
  const openGraphUrl = exactIdentity(envelope['openGraphUrls']);
  const candidateSources = decodeCandidateSources(envelope['candidateSources']);
  const candidateUrls = decodeStringArray(
    envelope['candidateUrls'],
    MAX_MEDIA_RESULTS,
    MAX_VALUE_LENGTH,
  );
  if (
    canonicalUrl === null ||
    openGraphUrl === null ||
    canonicalUrl !== openGraphUrl ||
    candidateSources === null ||
    candidateUrls === null ||
    candidateSources.length !== candidateUrls.length
  ) {
    return fail('RENDERED_RESPONSE_INVALID');
  }
  return { canonicalUrl, openGraphUrl, candidateSources, candidateUrls };
}

function assertIdentity(page: DecodedRenderedPage, post: NormalizedThreadsPost): void {
  if (!renderedIdentityValues(post).includes(page.canonicalUrl)) {
    return fail('RENDERED_RESPONSE_INVALID');
  }
}

function decodeCandidates(page: DecodedRenderedPage): readonly MediaCandidate[] {
  const candidates = new Map<string, MediaCandidate>();
  for (let index = 0; index < page.candidateUrls.length; index += 1) {
    try {
      const value = parseCdnUrl(page.candidateUrls[index]!.trim());
      const candidate: MediaCandidate = { source: page.candidateSources[index]!, value };
      candidates.set(value.url.href, candidates.get(value.url.href) ?? candidate);
    } catch (error: unknown) {
      if (!(error instanceof UpstreamPolicyError) || error.code !== 'CDN_URL_INVALID') {
        throw error;
      }
    }
  }
  return [...candidates.values()];
}

export function createRenderedThreadsMediaResolver(
  dependencies: RenderedThreadsMediaResolverDependencies,
): PublicThreadsMediaResolver {
  return {
    async resolve(post): Promise<ResolvedThreadsMedia> {
      let rawPage: unknown;
      try {
        rawPage = await dependencies.page.render(renderedMediaUrl(post));
      } catch {
        return fail('RENDERED_UNAVAILABLE');
      }
      const page = decodeRenderedPage(rawPage);
      assertIdentity(page, post);
      const candidates = decodeCandidates(page);
      return candidates.length === 0
        ? fail('RENDERED_MEDIA_NOT_FOUND')
        : { candidates: [...candidates] };
    },
  };
}

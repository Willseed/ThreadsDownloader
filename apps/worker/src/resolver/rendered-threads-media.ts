import { decodeExactRecord } from '@threads-downloader/contracts/strict-json';

import {
  parseCdnUrl,
  type NormalizedThreadsPost,
  UpstreamPolicyError,
} from '../security/upstream-policy.js';
import type { MediaCandidate, RenderedMediaCandidateSource } from './structured-media.js';

const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_SELECTOR_RESULTS = 16;
const MAX_TOTAL_RESULTS = 32;
const MAX_ATTRIBUTES = 64;
const MAX_ATTRIBUTE_NAME_LENGTH = 128;
const MAX_ATTRIBUTE_VALUE_LENGTH = 4096;
const MAX_HTML_LENGTH = 32 * 1024;
const MAX_TEXT_LENGTH = 16 * 1024;
const MAX_CANDIDATES = 1;
const MAX_LAYOUT_MAGNITUDE = 10_000_000;
const CANONICAL_CONTENT_LENGTH = /^(?:0|[1-9]\d*)$/u;
const JSON_MEDIA_TYPE = 'application/json';
const CANONICAL_LINK_SELECTOR = 'link[rel="canonical"]';
const OPEN_GRAPH_URL_SELECTOR = 'meta[property="og:url"]';
const VIDEO_SELECTOR = 'video[src]';
const SOURCE_SELECTOR = 'video source[src]';
const NAVIGATION_TIMEOUT_MS = 4_000;
const ACTION_TIMEOUT_MS = 6_000;
export const RENDERED_BROWSER_BUDGET_MS = NAVIGATION_TIMEOUT_MS + ACTION_TIMEOUT_MS;
export const RENDERED_RESPONSE_READ_TIMEOUT_MS = 2_000;
export const RENDERED_RESOLVER_BUDGET_MS =
  RENDERED_BROWSER_BUDGET_MS + RENDERED_RESPONSE_READ_TIMEOUT_MS;

export const RENDERED_ALLOWED_REQUEST_PATTERNS = [
  String.raw`^https:\/\/www\.threads\.com\/`,
  String.raw`^https:\/\/(?:[a-z0-9-]+\.)*cdninstagram\.com\/`,
  String.raw`^https:\/\/instagram\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.fna\.fbcdn\.net\/`,
] as const;

export interface RenderedBrowserScrapeOptions {
  readonly actionTimeout: number;
  readonly allowRequestPattern: string[];
  readonly bestAttempt: false;
  readonly cacheTTL: 0;
  readonly cookies: [];
  readonly elements: Array<{ readonly selector: string }>;
  readonly gotoOptions: {
    readonly timeout: number;
    readonly waitUntil: 'domcontentloaded';
  };
  readonly setJavaScriptEnabled: true;
  readonly url: string;
  readonly waitForSelector: {
    readonly selector: 'video[src]';
    readonly timeout: 5_000;
    readonly visible: true;
  };
  readonly waitForTimeout: number;
}

export interface BrowserRunScrapePort {
  quickAction(action: 'scrape', options: RenderedBrowserScrapeOptions): Promise<Response>;
}

export function createBrowserRunScrapePort(browser: BrowserRun): BrowserRunScrapePort {
  return {
    quickAction(action, options) {
      return browser.quickAction(action, options);
    },
  };
}

export type RenderedThreadsMediaResolverErrorCode =
  | 'RENDERED_MEDIA_NOT_FOUND'
  | 'RENDERED_RESPONSE_INVALID'
  | 'RENDERED_RESPONSE_TOO_LARGE'
  | 'RENDERED_UNAVAILABLE';

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
  readonly browser: BrowserRunScrapePort;
  readonly timeoutSignal?: (milliseconds: number) => AbortSignal;
}

interface DecodedAttribute {
  readonly name: string;
  readonly value: string;
}

interface DecodedElement {
  readonly attributes: readonly DecodedAttribute[];
}

interface IdentityScrapeTarget {
  readonly attribute: string;
  readonly expectedValue: string;
  readonly kind: 'identity';
  readonly selector: string;
}

interface MediaScrapeTarget {
  readonly attribute: 'src';
  readonly kind: 'media';
  readonly selector: string;
  readonly source: RenderedMediaCandidateSource;
}

type ScrapeTarget = IdentityScrapeTarget | MediaScrapeTarget;

function fail(code: RenderedThreadsMediaResolverErrorCode): never {
  throw new RenderedThreadsMediaResolverError(code);
}

function renderedMediaUrl(post: NormalizedThreadsPost): string {
  return `${post.canonicalUrl}/media`;
}

function scrapeTargets(post: NormalizedThreadsPost): readonly ScrapeTarget[] {
  return [
    {
      selector: CANONICAL_LINK_SELECTOR,
      attribute: 'href',
      expectedValue: post.canonicalUrl,
      kind: 'identity',
    },
    {
      selector: OPEN_GRAPH_URL_SELECTOR,
      attribute: 'content',
      expectedValue: post.canonicalUrl,
      kind: 'identity',
    },
    {
      selector: VIDEO_SELECTOR,
      attribute: 'src',
      kind: 'media',
      source: 'rendered-video',
    },
    {
      selector: SOURCE_SELECTOR,
      attribute: 'src',
      kind: 'media',
      source: 'rendered-source',
    },
  ];
}

function scrapeOptions(
  post: NormalizedThreadsPost,
  targets: readonly ScrapeTarget[],
): RenderedBrowserScrapeOptions {
  const options: RenderedBrowserScrapeOptions = {
    url: renderedMediaUrl(post),
    cookies: [],
    cacheTTL: 0,
    allowRequestPattern: [...RENDERED_ALLOWED_REQUEST_PATTERNS],
    setJavaScriptEnabled: true,
    gotoOptions: { timeout: NAVIGATION_TIMEOUT_MS, waitUntil: 'domcontentloaded' },
    actionTimeout: ACTION_TIMEOUT_MS,
    waitForSelector: { selector: VIDEO_SELECTOR, visible: true, timeout: 5_000 },
    waitForTimeout: 250,
    bestAttempt: false,
    elements: targets.map(({ selector }) => ({ selector })),
  };
  options satisfies BrowserRunScrapeOptions;
  return options;
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

function assertResponseHeaders(response: Response): void {
  if (response.status !== 200) {
    return fail('RENDERED_UNAVAILABLE');
  }
  const contentType = response.headers.get('content-type');
  if (contentType === null) {
    return fail('RENDERED_RESPONSE_INVALID');
  }
  const separator = contentType.indexOf(';');
  const mediaType = contentType.slice(0, separator === -1 ? contentType.length : separator);
  if (mediaType.trim().toLowerCase() !== JSON_MEDIA_TYPE) {
    return fail('RENDERED_RESPONSE_INVALID');
  }

  const contentLength = response.headers.get('content-length');
  if (contentLength === null) {
    return;
  }
  if (!CANONICAL_CONTENT_LENGTH.test(contentLength)) {
    return fail('RENDERED_RESPONSE_INVALID');
  }
  const length = Number(contentLength);
  if (!Number.isSafeInteger(length)) {
    return fail('RENDERED_RESPONSE_INVALID');
  }
  if (length > MAX_RESPONSE_BYTES) {
    return fail('RENDERED_RESPONSE_TOO_LARGE');
  }
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  void reader.cancel().catch(() => undefined);
}

function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (!settled) {
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(new Error('RENDERED_RESPONSE_READ_TIMEOUT'));
      }
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    void reader.read().then(
      (result) => {
        if (!settled) {
          settled = true;
          signal.removeEventListener('abort', onAbort);
          resolve(result);
        }
      },
      (error: unknown) => {
        if (!settled) {
          settled = true;
          signal.removeEventListener('abort', onAbort);
          reject(error);
        }
      },
    );
  });
}

async function readBoundedResponse(response: Response, signal: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return fail('RENDERED_RESPONSE_INVALID');
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await readChunk(reader, signal);
      if (result.done) {
        break;
      }
      if (!(result.value instanceof Uint8Array)) {
        cancelReader(reader);
        return fail('RENDERED_RESPONSE_INVALID');
      }
      if (result.value.byteLength > MAX_RESPONSE_BYTES - total) {
        cancelReader(reader);
        return fail('RENDERED_RESPONSE_TOO_LARGE');
      }
      chunks.push(result.value.slice());
      total += result.value.byteLength;
    }
  } catch (error: unknown) {
    cancelReader(reader);
    if (error instanceof RenderedThreadsMediaResolverError) {
      throw error;
    }
    return fail('RENDERED_UNAVAILABLE');
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
    return fail('RENDERED_RESPONSE_INVALID');
  }
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum;
}

function boundedLayoutValue(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_LAYOUT_MAGNITUDE
  );
}

function decodeAttribute(value: unknown): DecodedAttribute | null {
  const record = decodeExactRecord(value, ['name', 'value']);
  if (
    record === null ||
    !boundedString(record['name'], MAX_ATTRIBUTE_NAME_LENGTH) ||
    record['name'].length === 0 ||
    !boundedString(record['value'], MAX_ATTRIBUTE_VALUE_LENGTH)
  ) {
    return null;
  }
  return { name: record['name'], value: record['value'] };
}

function decodeElement(value: unknown): DecodedElement | null {
  const record = decodeExactRecord(value, [
    'html',
    'text',
    'width',
    'height',
    'top',
    'left',
    'attributes',
  ]);
  if (
    record === null ||
    !boundedString(record['html'], MAX_HTML_LENGTH) ||
    !boundedString(record['text'], MAX_TEXT_LENGTH) ||
    !boundedLayoutValue(record['width']) ||
    !boundedLayoutValue(record['height']) ||
    !boundedLayoutValue(record['top']) ||
    !boundedLayoutValue(record['left']) ||
    !Array.isArray(record['attributes']) ||
    record['attributes'].length > MAX_ATTRIBUTES
  ) {
    return null;
  }
  const attributes: DecodedAttribute[] = [];
  const names = new Set<string>();
  for (const value of record['attributes']) {
    const attribute = decodeAttribute(value);
    if (attribute === null || names.has(attribute.name)) {
      return null;
    }
    names.add(attribute.name);
    attributes.push(attribute);
  }
  return { attributes };
}

function candidateFrom(
  attributes: readonly DecodedAttribute[],
  target: MediaScrapeTarget,
): MediaCandidate | undefined {
  const rawValue = attributes.find(({ name }) => name === target.attribute)?.value;
  if (rawValue === undefined) {
    return fail('RENDERED_RESPONSE_INVALID');
  }
  try {
    return { source: target.source, value: parseCdnUrl(rawValue.trim()) };
  } catch (error: unknown) {
    if (error instanceof UpstreamPolicyError && error.code === 'CDN_URL_INVALID') {
      return undefined;
    }
    throw error;
  }
}

function decodeSelectorElements(value: unknown, target: ScrapeTarget): readonly DecodedElement[] {
  const selectorRecord = decodeExactRecord(value, ['selector', 'results']);
  if (
    selectorRecord === null ||
    selectorRecord['selector'] !== target.selector ||
    !Array.isArray(selectorRecord['results']) ||
    selectorRecord['results'].length > MAX_SELECTOR_RESULTS
  ) {
    return fail('RENDERED_RESPONSE_INVALID');
  }
  const elements: DecodedElement[] = [];
  for (const result of selectorRecord['results']) {
    const decoded = decodeElement(result);
    if (decoded === null) {
      return fail('RENDERED_RESPONSE_INVALID');
    }
    elements.push(decoded);
  }
  return elements;
}

function collectCandidates(
  elements: readonly DecodedElement[],
  target: MediaScrapeTarget,
  candidates: Map<string, MediaCandidate>,
): void {
  for (const element of elements) {
    const candidate = candidateFrom(element.attributes, target);
    if (candidate === undefined) {
      continue;
    }
    candidates.set(candidate.value.url.href, candidates.get(candidate.value.url.href) ?? candidate);
    if (candidates.size > MAX_CANDIDATES) {
      return fail('RENDERED_RESPONSE_INVALID');
    }
  }
}

function assertIdentity(elements: readonly DecodedElement[], target: IdentityScrapeTarget): void {
  if (elements.length !== 1) {
    return fail('RENDERED_RESPONSE_INVALID');
  }
  const values = elements[0]!.attributes.filter(({ name }) => name === target.attribute);
  if (values.length !== 1 || values[0]!.value !== target.expectedValue) {
    return fail('RENDERED_RESPONSE_INVALID');
  }
}

function decodeCandidates(
  value: unknown,
  targets: readonly ScrapeTarget[],
): readonly MediaCandidate[] {
  const envelope = decodeExactRecord(value, ['success', 'result']);
  if (envelope === null || envelope['success'] !== true || !Array.isArray(envelope['result'])) {
    return fail('RENDERED_RESPONSE_INVALID');
  }
  if (envelope['result'].length !== targets.length) {
    return fail('RENDERED_RESPONSE_INVALID');
  }

  const candidates = new Map<string, MediaCandidate>();
  let totalResults = 0;
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index]!;
    const elements = decodeSelectorElements(envelope['result'][index], target);
    totalResults += elements.length;
    if (totalResults > MAX_TOTAL_RESULTS) {
      return fail('RENDERED_RESPONSE_INVALID');
    }
    if (target.kind === 'identity') {
      assertIdentity(elements, target);
    } else {
      collectCandidates(elements, target, candidates);
    }
  }
  return [...candidates.values()];
}

async function decodeResponse(
  response: Response,
  targets: readonly ScrapeTarget[],
  timeoutSignal: (milliseconds: number) => AbortSignal,
): Promise<readonly MediaCandidate[]> {
  try {
    assertResponseHeaders(response);
  } catch (error: unknown) {
    cancelBody(response);
    throw error;
  }
  let signal: AbortSignal;
  try {
    signal = timeoutSignal(RENDERED_RESPONSE_READ_TIMEOUT_MS);
  } catch {
    cancelBody(response);
    return fail('RENDERED_UNAVAILABLE');
  }
  const text = await readBoundedResponse(response, signal);
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return fail('RENDERED_RESPONSE_INVALID');
  }
  return decodeCandidates(value, targets);
}

export function createRenderedThreadsMediaResolver(
  dependencies: RenderedThreadsMediaResolverDependencies,
): PublicThreadsMediaResolver {
  const timeoutSignal = dependencies.timeoutSignal ?? AbortSignal.timeout;
  return {
    async resolve(post): Promise<ResolvedThreadsMedia> {
      const targets = scrapeTargets(post);
      let response: Response;
      try {
        response = await dependencies.browser.quickAction('scrape', scrapeOptions(post, targets));
      } catch {
        return fail('RENDERED_UNAVAILABLE');
      }
      const candidates = await decodeResponse(response, targets, timeoutSignal);
      return candidates.length === 0
        ? fail('RENDERED_MEDIA_NOT_FOUND')
        : { candidates: [...candidates] };
    },
  };
}

import { parseCdnUrl, type CdnUrl, UpstreamPolicyError } from '../security/upstream-policy.js';

const MAX_MARKUP_BYTES = 2 * 1024 * 1024;
const MAX_TOKEN_LENGTH = 64 * 1024;
const MAX_ATTRIBUTE_LENGTH = 16 * 1024;
const MAX_ATTRIBUTES = 128;
const MAX_VIDEO_DEPTH = 32;
const MAX_SCRIPT_PAYLOADS = 128;
const MAX_CANDIDATES = 10;
const MAX_BUCKET_ENTRIES = MAX_CANDIDATES * 2;

const PRIORITIES = ['og:video', 'og:video:url', 'og:video:secure_url', 'video', 'source'] as const;

export type MarkupCandidateSource = (typeof PRIORITIES)[number];

export interface MarkupMediaCandidate {
  readonly source: MarkupCandidateSource;
  readonly value: CdnUrl;
}

export interface MarkupScriptPayload {
  readonly text: string;
  readonly type: string | null;
}

export interface MediaMarkupParts {
  readonly candidates: readonly MarkupMediaCandidate[];
  readonly scripts: readonly MarkupScriptPayload[];
}

export type MarkupTagsErrorCode = 'MARKUP_STRUCTURE_LIMIT' | 'MARKUP_TOO_LARGE';

export class MarkupTagsError extends Error {
  constructor(readonly code: MarkupTagsErrorCode) {
    super(code);
    this.name = 'MarkupTagsError';
  }
}

interface ParsedTag {
  readonly attributes: ReadonlyMap<string, string>;
  readonly end: number;
  readonly isEnd: boolean;
  readonly name: string;
  readonly selfClosing: boolean;
}

interface ParsedAttribute {
  readonly end: number;
  readonly name: string;
  readonly value: string;
}

interface ScannedToken {
  readonly end: number;
  readonly tag?: ParsedTag;
}

interface ScannedScript {
  readonly end: number;
  readonly text: string;
}

type CandidateBuckets = ReadonlyMap<MarkupCandidateSource, Map<string, MarkupMediaCandidate>>;

function markupError(code: MarkupTagsErrorCode): never {
  throw new MarkupTagsError(code);
}

function isWhitespace(character: string | undefined): boolean {
  return (
    character === ' ' ||
    character === '\n' ||
    character === '\r' ||
    character === '\t' ||
    character === '\f'
  );
}

function isNameCharacter(character: string | undefined): boolean {
  if (character === undefined) {
    return false;
  }
  const code = character.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    character === ':' ||
    character === '-' ||
    character === '_' ||
    character === '.'
  );
}

function isAsciiLetter(character: string | undefined): boolean {
  if (character === undefined) {
    return false;
  }
  const code = character.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function equalsAsciiCaseInsensitiveAt(markup: string, start: number, expected: string): boolean {
  if (start + expected.length > markup.length) {
    return false;
  }
  for (let offset = 0; offset < expected.length; offset += 1) {
    if (markup[start + offset]?.toLowerCase() !== expected[offset]) {
      return false;
    }
  }
  return true;
}

function isDecimalDigit(character: string): boolean {
  const code = character.charCodeAt(0);
  return code >= 48 && code <= 57;
}

function isHexDigit(character: string): boolean {
  const code = character.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
}

function decodeNumericEntity(body: string): string | undefined {
  const isHex = body.startsWith('#x') || body.startsWith('#X');
  const digits = body.slice(isHex ? 2 : 1);
  if (
    !body.startsWith('#') ||
    digits.length === 0 ||
    ![...digits].every(isHex ? isHexDigit : isDecimalDigit)
  ) {
    return undefined;
  }

  const codePoint = Number.parseInt(digits, isHex ? 16 : 10);
  if (codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
    return undefined;
  }
  return String.fromCodePoint(codePoint);
}

function decodeEntity(body: string): string | undefined {
  if (body === 'amp') {
    return '&';
  }
  if (body === 'quot') {
    return '"';
  }
  return decodeNumericEntity(body);
}

function decodeLimitedEntities(value: string): string {
  let decoded = '';
  let cursor = 0;
  while (cursor < value.length) {
    if (value[cursor] !== '&') {
      decoded += value[cursor];
      cursor += 1;
      continue;
    }

    const semicolon = value.indexOf(';', cursor + 1);
    if (semicolon === -1 || semicolon - cursor > 12) {
      decoded += '&';
      cursor += 1;
      continue;
    }

    const replacement = decodeEntity(value.slice(cursor + 1, semicolon));
    if (replacement === undefined) {
      decoded += value.slice(cursor, semicolon + 1);
    } else {
      decoded += replacement;
    }
    cursor = semicolon + 1;
  }
  return decoded;
}

function assertWithinToken(start: number, cursor: number): void {
  if (cursor - start > MAX_TOKEN_LENGTH) {
    markupError('MARKUP_STRUCTURE_LIMIT');
  }
}

function skipWhitespace(markup: string, initial: number): number {
  let cursor = initial;
  while (isWhitespace(markup[cursor])) {
    cursor += 1;
  }
  return cursor;
}

function readAttributeValue(
  markup: string,
  initial: number,
  tagStart: number,
): { readonly end: number; readonly value: string } {
  const quote = markup[initial];
  if (quote === '"' || quote === "'") {
    const valueStart = initial + 1;
    let cursor = valueStart;
    while (cursor < markup.length && markup[cursor] !== quote) {
      cursor += 1;
      assertWithinToken(tagStart, cursor);
      if (cursor - valueStart > MAX_ATTRIBUTE_LENGTH) {
        markupError('MARKUP_STRUCTURE_LIMIT');
      }
    }
    if (markup[cursor] !== quote) {
      return markupError('MARKUP_STRUCTURE_LIMIT');
    }
    return { end: cursor + 1, value: decodeLimitedEntities(markup.slice(valueStart, cursor)) };
  }

  const valueStart = initial;
  let cursor = initial;
  while (cursor < markup.length && !isWhitespace(markup[cursor]) && markup[cursor] !== '>') {
    if (markup[cursor] === '<') {
      return markupError('MARKUP_STRUCTURE_LIMIT');
    }
    cursor += 1;
    assertWithinToken(tagStart, cursor);
    if (cursor - valueStart > MAX_ATTRIBUTE_LENGTH) {
      markupError('MARKUP_STRUCTURE_LIMIT');
    }
  }
  return { end: cursor, value: decodeLimitedEntities(markup.slice(valueStart, cursor)) };
}

function readAttribute(markup: string, initial: number, tagStart: number): ParsedAttribute {
  let cursor = initial;
  const nameStart = cursor;
  while (isNameCharacter(markup[cursor])) {
    cursor += 1;
  }
  if (cursor === nameStart) {
    return markupError('MARKUP_STRUCTURE_LIMIT');
  }

  const name = markup.slice(nameStart, cursor).toLowerCase();
  cursor = skipWhitespace(markup, cursor);
  if (markup[cursor] !== '=') {
    return { end: cursor, name, value: '' };
  }

  cursor = skipWhitespace(markup, cursor + 1);
  const parsedValue = readAttributeValue(markup, cursor, tagStart);
  return { end: parsedValue.end, name, value: parsedValue.value };
}

function readAttributes(
  markup: string,
  initial: number,
  tagStart: number,
): {
  readonly attributes: ReadonlyMap<string, string>;
  readonly end: number;
  readonly selfClosing: boolean;
} {
  const attributes = new Map<string, string>();
  let attributeCount = 0;
  let cursor = initial;

  while (cursor < markup.length) {
    cursor = skipWhitespace(markup, cursor);
    assertWithinToken(tagStart, cursor);
    if (markup[cursor] === '>') {
      return { attributes, end: cursor + 1, selfClosing: false };
    }
    if (markup[cursor] === '/' && markup[cursor + 1] === '>') {
      return { attributes, end: cursor + 2, selfClosing: true };
    }

    attributeCount += 1;
    if (attributeCount > MAX_ATTRIBUTES) {
      return markupError('MARKUP_STRUCTURE_LIMIT');
    }
    const attribute = readAttribute(markup, cursor, tagStart);
    cursor = attribute.end;
    if (!attributes.has(attribute.name)) {
      attributes.set(attribute.name, attribute.value);
    }
  }
  return markupError('MARKUP_STRUCTURE_LIMIT');
}

function parseTag(markup: string, start: number): ParsedTag | undefined {
  let cursor = start + 1;
  const isEnd = markup[cursor] === '/';
  if (isEnd) {
    cursor += 1;
  }
  if (!isAsciiLetter(markup[cursor])) {
    return undefined;
  }

  const nameStart = cursor;
  while (isNameCharacter(markup[cursor])) {
    cursor += 1;
  }
  if (cursor === nameStart) {
    return undefined;
  }
  const name = markup.slice(nameStart, cursor).toLowerCase();
  const parsed = readAttributes(markup, cursor, start);
  return { ...parsed, isEnd, name };
}

function skipComment(markup: string, start: number): number {
  const end = markup.indexOf('-->', start + 4);
  if (end === -1 || end + 3 - start > MAX_TOKEN_LENGTH) {
    return markupError('MARKUP_STRUCTURE_LIMIT');
  }
  return end + 3;
}

function scanNextToken(markup: string, cursor: number): ScannedToken | undefined {
  const tagStart = markup.indexOf('<', cursor);
  if (tagStart === -1) {
    return undefined;
  }
  if (markup.startsWith('<!--', tagStart)) {
    return { end: skipComment(markup, tagStart) };
  }

  const tag = parseTag(markup, tagStart);
  return tag === undefined ? { end: tagStart + 1 } : { end: tag.end, tag };
}

function scanScript(markup: string, start: number): ScannedScript {
  let cursor = start;
  while (cursor < markup.length) {
    if (cursor - start > MAX_TOKEN_LENGTH) {
      return markupError('MARKUP_STRUCTURE_LIMIT');
    }
    if (
      markup[cursor] === '<' &&
      markup[cursor + 1] === '/' &&
      equalsAsciiCaseInsensitiveAt(markup, cursor + 2, 'script') &&
      !isNameCharacter(markup[cursor + 8])
    ) {
      const closingTag = parseTag(markup, cursor);
      if (closingTag?.isEnd === true && closingTag.name === 'script') {
        return { end: closingTag.end, text: markup.slice(start, cursor) };
      }
    }
    cursor += 1;
  }
  return markupError('MARKUP_STRUCTURE_LIMIT');
}

function createBuckets(): CandidateBuckets {
  return new Map(PRIORITIES.map((source) => [source, new Map<string, MarkupMediaCandidate>()]));
}

function addCandidate(
  buckets: CandidateBuckets,
  source: MarkupCandidateSource,
  rawValue: string | undefined,
): void {
  if (rawValue === undefined) {
    return;
  }

  let value: CdnUrl;
  try {
    value = parseCdnUrl(rawValue.trim());
  } catch (error) {
    if (error instanceof UpstreamPolicyError && error.code === 'CDN_URL_INVALID') {
      return;
    }
    throw error;
  }

  const bucket = buckets.get(source)!;
  if (bucket.size < MAX_BUCKET_ENTRIES) {
    bucket.set(value.url.href, { source, value });
  }
}

function metaSources(attributes: ReadonlyMap<string, string>): readonly MarkupCandidateSource[] {
  const matched = new Set<MarkupCandidateSource>();
  for (const marker of [attributes.get('property'), attributes.get('name')]) {
    const normalized = marker?.trim().toLowerCase();
    if (
      normalized === 'og:video' ||
      normalized === 'og:video:url' ||
      normalized === 'og:video:secure_url'
    ) {
      matched.add(normalized);
    }
  }
  return [...matched];
}

function collectTagCandidates(tag: ParsedTag, videoDepth: number, buckets: CandidateBuckets): void {
  if (tag.isEnd) {
    return;
  }
  if (tag.name === 'meta') {
    for (const source of metaSources(tag.attributes)) {
      addCandidate(buckets, source, tag.attributes.get('content'));
    }
    return;
  }
  if (tag.name === 'video') {
    addCandidate(buckets, 'video', tag.attributes.get('src'));
    return;
  }
  if (tag.name === 'source' && videoDepth > 0) {
    addCandidate(buckets, 'source', tag.attributes.get('src'));
  }
}

function applyTag(tag: ParsedTag, videoDepth: number, buckets: CandidateBuckets): number {
  if (tag.isEnd && tag.name === 'video') {
    return Math.max(0, videoDepth - 1);
  }

  collectTagCandidates(tag, videoDepth, buckets);
  if (tag.isEnd || tag.selfClosing || tag.name !== 'video') {
    return videoDepth;
  }

  const nextDepth = videoDepth + 1;
  if (nextDepth > MAX_VIDEO_DEPTH) {
    return markupError('MARKUP_STRUCTURE_LIMIT');
  }
  return nextDepth;
}

function flattenBuckets(buckets: CandidateBuckets): readonly MarkupMediaCandidate[] {
  const candidates: MarkupMediaCandidate[] = [];
  const seen = new Set<string>();
  for (const source of PRIORITIES) {
    for (const [canonical, candidate] of buckets.get(source)!) {
      if (seen.has(canonical)) {
        continue;
      }
      seen.add(canonical);
      candidates.push(candidate);
      if (candidates.length === MAX_CANDIDATES) {
        return candidates;
      }
    }
  }
  return candidates;
}

function assertMarkupSize(markup: string): void {
  if (
    markup.length > MAX_MARKUP_BYTES ||
    new TextEncoder().encode(markup).byteLength > MAX_MARKUP_BYTES
  ) {
    markupError('MARKUP_TOO_LARGE');
  }
}

export function extractMediaMarkupParts(markup: string): MediaMarkupParts {
  assertMarkupSize(markup);
  const buckets = createBuckets();
  const scripts: MarkupScriptPayload[] = [];
  let cursor = 0;
  let videoDepth = 0;

  while (cursor < markup.length) {
    const token = scanNextToken(markup, cursor);
    if (token === undefined) {
      break;
    }
    cursor = token.end;
    if (token.tag !== undefined) {
      videoDepth = applyTag(token.tag, videoDepth, buckets);
      if (!token.tag.isEnd && !token.tag.selfClosing && token.tag.name === 'script') {
        if (scripts.length === MAX_SCRIPT_PAYLOADS) {
          return markupError('MARKUP_STRUCTURE_LIMIT');
        }
        const script = scanScript(markup, cursor);
        scripts.push({ text: script.text, type: token.tag.attributes.get('type') ?? null });
        cursor = script.end;
      }
    }
  }

  return { candidates: flattenBuckets(buckets), scripts };
}

export function extractMediaTags(markup: string): readonly MarkupMediaCandidate[] {
  return extractMediaMarkupParts(markup).candidates;
}

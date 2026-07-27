import { parseCdnUrl, type CdnUrl, UpstreamPolicyError } from '../security/upstream-policy.js';
import {
  extractMediaMarkupParts,
  type MarkupCandidateSource,
  type MarkupScriptPayload,
} from './markup-tags.js';

const MAX_CANDIDATES = 10;
const MAX_JSON_DEPTH = 12;
const MAX_JSON_NODES = 10_000;
const MAX_JSON_STRING_LENGTH = 4096;

const CANDIDATE_KEYS = new Set(['contentUrl', 'video_url', 'videoUrl', 'src', 'url']);
const STRUCTURED_PRIORITIES = ['json-ld', 'application-json', 'json'] as const;

export type StructuredMediaCandidateSource = (typeof STRUCTURED_PRIORITIES)[number];
export type RenderedMediaCandidateSource =
  'rendered-current-src' | 'rendered-source' | 'rendered-video';
export type MediaCandidateSource =
  MarkupCandidateSource | StructuredMediaCandidateSource | RenderedMediaCandidateSource;

export interface MediaCandidate {
  readonly source: MediaCandidateSource;
  readonly value: CdnUrl;
}

interface TraversalState {
  readonly candidates: Map<string, CdnUrl>;
  readonly excluded: ReadonlySet<string>;
  nodes: number;
}

interface ParsedJson {
  readonly valid: true;
  readonly value: unknown;
}

function parseWholeJson(text: string): ParsedJson | undefined {
  try {
    return { valid: true, value: JSON.parse(text) as unknown };
  } catch {
    return undefined;
  }
}

function addCandidate(state: TraversalState, rawValue: string): void {
  let value: CdnUrl;
  try {
    value = parseCdnUrl(rawValue.trim());
  } catch (error: unknown) {
    if (error instanceof UpstreamPolicyError && error.code === 'CDN_URL_INVALID') {
      return;
    }
    throw error;
  }

  const canonical = value.url.href;
  if (
    !state.excluded.has(canonical) &&
    !state.candidates.has(canonical) &&
    state.candidates.size < MAX_CANDIDATES
  ) {
    state.candidates.set(canonical, value);
  }
}

function traverseObject(value: object, depth: number, state: TraversalState): boolean {
  for (const [key, entry] of Object.entries(value)) {
    if (key.length > MAX_JSON_STRING_LENGTH || !traverseJson(entry, depth + 1, state)) {
      return false;
    }
    if (CANDIDATE_KEYS.has(key) && typeof entry === 'string') {
      addCandidate(state, entry);
    }
  }
  return true;
}

function traverseJson(value: unknown, depth: number, state: TraversalState): boolean {
  if (depth > MAX_JSON_DEPTH || ++state.nodes > MAX_JSON_NODES) {
    return false;
  }
  if (typeof value === 'string') {
    return value.length <= MAX_JSON_STRING_LENGTH;
  }
  if (typeof value !== 'object' || value === null) {
    return true;
  }
  return Array.isArray(value)
    ? value.every((entry) => traverseJson(entry, depth + 1, state))
    : traverseObject(value, depth, state);
}

function extractPayloadCandidates(
  payload: MarkupScriptPayload,
  excluded: ReadonlySet<string>,
): readonly CdnUrl[] {
  const parsed = parseWholeJson(payload.text);
  if (parsed === undefined) {
    return [];
  }

  const state: TraversalState = { candidates: new Map(), excluded, nodes: 0 };
  return traverseJson(parsed.value, 0, state) ? [...state.candidates.values()] : [];
}

function classifyPayload(payload: MarkupScriptPayload): StructuredMediaCandidateSource {
  const type = payload.type?.trim().toLowerCase();
  if (type === 'application/ld+json') {
    return 'json-ld';
  }
  if (type === 'application/json') {
    return 'application-json';
  }
  return 'json';
}

export function extractMediaCandidates(markup: string): readonly MediaCandidate[] {
  const parts = extractMediaMarkupParts(markup);
  const candidates: MediaCandidate[] = [...parts.candidates];
  const seen = new Set(candidates.map((candidate) => candidate.value.url.href));

  for (const source of STRUCTURED_PRIORITIES) {
    for (const payload of parts.scripts) {
      if (classifyPayload(payload) !== source) {
        continue;
      }
      for (const value of extractPayloadCandidates(payload, seen)) {
        candidates.push({ source, value });
        seen.add(value.url.href);
        if (candidates.length === MAX_CANDIDATES) {
          return candidates;
        }
      }
    }
  }

  return candidates;
}

import { decodeExactRecord } from '@threads-downloader/contracts/strict-json';

import { normalizeProbedMedia, type ProbedMedia } from '../resolver/media-probe.js';

const PROBED_MEDIA_WIRE_FIELDS = [
  'finalUrl',
  'contentType',
  'contentLength',
  'rangeCapability',
  'strongEtag',
  'lastModified',
  'completionReliable',
  'probeMethod',
] as const;
const INVALID_PROBED_MEDIA_WIRE = 'PROBED_MEDIA_WIRE_INVALID';

export interface ProbedMediaWire {
  readonly finalUrl: string;
  readonly contentType: string;
  readonly contentLength: number | null;
  readonly rangeCapability: ProbedMedia['rangeCapability'];
  readonly strongEtag: string | null;
  readonly lastModified: string | null;
  readonly completionReliable: boolean;
  readonly probeMethod: ProbedMedia['probeMethod'];
}

export function encodeProbedMediaWire(media: ProbedMedia): ProbedMediaWire {
  let normalized: ProbedMedia;
  try {
    normalized = normalizeProbedMedia(media);
  } catch {
    throw new Error(INVALID_PROBED_MEDIA_WIRE);
  }
  return {
    finalUrl: normalized.finalUrl.url.href,
    contentType: normalized.contentType,
    contentLength: normalized.contentLength,
    rangeCapability: normalized.rangeCapability,
    strongEtag: normalized.strongEtag,
    lastModified: normalized.lastModified,
    completionReliable: normalized.completionReliable,
    probeMethod: normalized.probeMethod,
  };
}

export function decodeProbedMediaWire(value: unknown): ProbedMedia | null {
  const record = decodeExactRecord(value, PROBED_MEDIA_WIRE_FIELDS);
  if (record === null) {
    return null;
  }
  try {
    return normalizeProbedMedia(record);
  } catch {
    return null;
  }
}

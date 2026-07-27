import type { ProbedMedia } from '../resolver/media-probe.js';
import {
  PreviewCapabilityError,
  createPreviewCapabilityCodec,
  type IssuedPreviewCapability,
  type PreviewCapabilityCodec,
} from '../security/preview-capability.js';
import {
  claimResolvedMediaCandidate,
  ResolveVaultError,
  settleResolvedMediaClaim,
  type ResolvedMediaClaim,
} from '../security/resolve-vault.js';
import type { BrowserSessionIdentity, SessionNamespace } from '../security/session-client.js';
import type { CdnUrl } from '../security/upstream-policy.js';
import { decodeBase64Url } from '../utils/base64url.js';

const SESSION_ID_BYTES = 32;
const SESSION_HASH_BYTES = 32;
const OPAQUE_ID_BYTES = 24;

export interface IssuePreviewSessionInput {
  readonly identity: BrowserSessionIdentity;
  readonly csrfHash: string;
  readonly resolveId: string;
  readonly candidateId: string;
}

export interface OpenPreviewSessionInput {
  readonly capability: string;
  readonly sessionHash: string;
}

export interface PreviewResolvedMediaPort {
  claim(input: IssuePreviewSessionInput): Promise<ResolvedMediaClaim>;
  release(input: IssuePreviewSessionInput & { readonly reservationId: string }): Promise<void>;
}

export interface PreviewCapabilityPort {
  seal(media: ProbedMedia, sessionHash: string, now: number): Promise<IssuedPreviewCapability>;
  open(capability: string, sessionHash: string, now: number): Promise<CdnUrl>;
}

export interface PreviewSessionDependencies {
  readonly capabilities: PreviewCapabilityPort;
  readonly resolvedMedia: PreviewResolvedMediaPort;
  readonly now: () => number;
}

export interface PreviewSessionService {
  issue(input: IssuePreviewSessionInput): Promise<IssuedPreviewCapability>;
  open(input: OpenPreviewSessionInput): Promise<CdnUrl>;
}

export type PreviewSessionErrorCode =
  | 'PREVIEW_CANDIDATE_UNAVAILABLE'
  | 'PREVIEW_REQUEST_INVALID'
  | 'PREVIEW_SESSION_EXPIRED'
  | 'PREVIEW_SESSION_UNAVAILABLE'
  | 'SESSION_INVALID';

export class PreviewSessionError extends Error {
  constructor(readonly code: PreviewSessionErrorCode) {
    super(code);
    this.name = 'PreviewSessionError';
  }
}

function fail(code: PreviewSessionErrorCode): never {
  throw new PreviewSessionError(code);
}

function hasCanonicalBytes(value: unknown, bytes: number): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    return decodeBase64Url(value).byteLength === bytes;
  } catch {
    return false;
  }
}

function requireIssueInput(input: IssuePreviewSessionInput): void {
  if (
    typeof input !== 'object' ||
    input === null ||
    typeof input.identity !== 'object' ||
    input.identity === null ||
    !hasCanonicalBytes(input.identity.rawId, SESSION_ID_BYTES) ||
    !hasCanonicalBytes(input.identity.sessionHash, SESSION_HASH_BYTES) ||
    !hasCanonicalBytes(input.csrfHash, SESSION_HASH_BYTES) ||
    !hasCanonicalBytes(input.resolveId, OPAQUE_ID_BYTES) ||
    !hasCanonicalBytes(input.candidateId, OPAQUE_ID_BYTES)
  ) {
    return fail('PREVIEW_REQUEST_INVALID');
  }
}

function safeNow(clock: () => number): number {
  let now: number;
  try {
    now = clock();
  } catch {
    return fail('PREVIEW_SESSION_UNAVAILABLE');
  }
  return Number.isSafeInteger(now) && now >= 0 ? now : fail('PREVIEW_SESSION_UNAVAILABLE');
}

function mapError(error: unknown): PreviewSessionError {
  if (error instanceof PreviewSessionError) {
    return error;
  }
  if (error instanceof ResolveVaultError) {
    switch (error.code) {
      case 'SESSION_INVALID':
        return new PreviewSessionError('SESSION_INVALID');
      case 'RESOLVE_VAULT_INVALID':
        return new PreviewSessionError('PREVIEW_REQUEST_INVALID');
      case 'RESOLVE_VAULT_CONFLICT':
      case 'RESOLVE_VAULT_NOT_FOUND':
        return new PreviewSessionError('PREVIEW_CANDIDATE_UNAVAILABLE');
      default:
        return new PreviewSessionError('PREVIEW_SESSION_UNAVAILABLE');
    }
  }
  if (error instanceof PreviewCapabilityError) {
    return new PreviewSessionError(
      error.code === 'PREVIEW_CAPABILITY_UNAVAILABLE'
        ? 'PREVIEW_SESSION_UNAVAILABLE'
        : 'PREVIEW_SESSION_EXPIRED',
    );
  }
  return new PreviewSessionError('PREVIEW_SESSION_UNAVAILABLE');
}

async function bestEffortRelease(
  port: PreviewResolvedMediaPort,
  input: IssuePreviewSessionInput,
  reservationId: string,
): Promise<void> {
  try {
    await port.release({ ...input, reservationId });
  } catch {
    // The resolve-vault reservation expires after 30 seconds if release cannot be confirmed.
  }
}

class BrowserBoundPreviewSessionService implements PreviewSessionService {
  constructor(private readonly dependencies: PreviewSessionDependencies) {}

  async issue(input: IssuePreviewSessionInput): Promise<IssuedPreviewCapability> {
    requireIssueInput(input);
    let claim: ResolvedMediaClaim;
    try {
      claim = await this.dependencies.resolvedMedia.claim(input);
    } catch (error: unknown) {
      throw mapError(error);
    }
    try {
      return await this.dependencies.capabilities.seal(
        claim.media,
        input.identity.sessionHash,
        safeNow(this.dependencies.now),
      );
    } catch (error: unknown) {
      throw mapError(error);
    } finally {
      await bestEffortRelease(this.dependencies.resolvedMedia, input, claim.reservationId);
    }
  }

  async open(input: OpenPreviewSessionInput): Promise<CdnUrl> {
    if (
      typeof input !== 'object' ||
      input === null ||
      !hasCanonicalBytes(input.sessionHash, SESSION_HASH_BYTES)
    ) {
      return fail('PREVIEW_REQUEST_INVALID');
    }
    try {
      return await this.dependencies.capabilities.open(
        input.capability,
        input.sessionHash,
        safeNow(this.dependencies.now),
      );
    } catch (error: unknown) {
      throw mapError(error);
    }
  }
}

export function createPreviewSessionService(
  dependencies: PreviewSessionDependencies,
): PreviewSessionService {
  return new BrowserBoundPreviewSessionService(dependencies);
}

export function createRemotePreviewSessionService(bindings: {
  readonly sessions: SessionNamespace;
  readonly encryptionKey: string;
  readonly now: () => number;
}): PreviewSessionService {
  let codec: Promise<PreviewCapabilityCodec> | null = null;
  const capabilities = (): Promise<PreviewCapabilityCodec> => {
    codec ??= createPreviewCapabilityCodec(bindings.encryptionKey);
    return codec;
  };
  return createPreviewSessionService({
    now: bindings.now,
    capabilities: {
      seal: async (...arguments_) => (await capabilities()).seal(...arguments_),
      open: async (...arguments_) => (await capabilities()).open(...arguments_),
    },
    resolvedMedia: {
      claim: (input) =>
        claimResolvedMediaCandidate({
          sessions: bindings.sessions,
          ...input,
          clock: bindings.now,
        }),
      release: (input) =>
        settleResolvedMediaClaim({
          sessions: bindings.sessions,
          ...input,
          now: safeNow(bindings.now),
          outcome: 'release',
        }),
    },
  });
}

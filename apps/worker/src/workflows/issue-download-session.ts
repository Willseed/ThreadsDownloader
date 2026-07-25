import type { ProbedMedia } from '../resolver/media-probe.js';
import {
  destroyDownloadSession,
  DownloadSessionClientError,
  initializeDownloadSession,
  type DownloadSessionNamespace,
  type InitializedDownloadSession,
} from '../security/download-session-client.js';
import {
  claimResolvedMediaCandidate,
  ResolveVaultError,
  settleResolvedMediaClaim,
  type ResolvedMediaClaim,
} from '../security/resolve-vault.js';
import type { BrowserSessionIdentity, SessionNamespace } from '../security/session-client.js';
import { decodeBase64Url } from '../utils/base64url.js';

const SESSION_ID_BYTES = 32;
const SESSION_HASH_BYTES = 32;
const OPAQUE_ID_BYTES = 24;
export const DOWNLOAD_SESSION_ISSUANCE_CLAIM_TIMEOUT_MS = 33_000;
export const DOWNLOAD_SESSION_ISSUANCE_INITIALIZE_TIMEOUT_MS = 17_000;
export const DOWNLOAD_SESSION_ISSUANCE_SETTLE_TIMEOUT_MS = 17_000;
export const DOWNLOAD_SESSION_ISSUANCE_DESTROY_TIMEOUT_MS = 9_000;

export interface IssueDownloadSessionInput {
  readonly identity: BrowserSessionIdentity;
  readonly csrfHash: string;
  readonly resolveId: string;
  readonly candidateId: string;
}

export interface IssuedBrowserDownloadSession {
  readonly downloadId: string;
  readonly startExpiresAt: number;
}

export interface ResolvedMediaSettlementInput extends IssueDownloadSessionInput {
  readonly reservationId: string;
  readonly outcome: 'consume' | 'release';
}

export interface ResolvedMediaIssuancePort {
  claim(input: IssueDownloadSessionInput): Promise<ResolvedMediaClaim>;
  settle(input: ResolvedMediaSettlementInput): Promise<void>;
}

export interface DownloadSessionIssuancePort {
  initialize(input: {
    readonly sessionHash: string;
    readonly filename: string;
    readonly shortcode: string;
    readonly media: ProbedMedia;
  }): Promise<InitializedDownloadSession>;
  destroy(input: { readonly downloadId: string; readonly sessionHash: string }): Promise<void>;
}

export interface DownloadSessionIssuerDependencies {
  readonly resolvedMedia: ResolvedMediaIssuancePort;
  readonly downloadSessions: DownloadSessionIssuancePort;
}

export interface DownloadSessionIssuer {
  issue(input: IssueDownloadSessionInput): Promise<IssuedBrowserDownloadSession>;
}

export type DownloadSessionIssuanceErrorCode =
  | 'DOWNLOAD_CANDIDATE_UNAVAILABLE'
  | 'DOWNLOAD_ISSUANCE_REQUEST_INVALID'
  | 'DOWNLOAD_SESSION_UNAVAILABLE'
  | 'SESSION_INVALID';

export type DownloadSessionIssuanceErrorStatus = 400 | 401 | 410 | 503;

export class DownloadSessionIssuanceError extends Error {
  constructor(
    readonly code: DownloadSessionIssuanceErrorCode,
    readonly status: DownloadSessionIssuanceErrorStatus,
  ) {
    super(code);
    this.name = 'DownloadSessionIssuanceError';
  }
}

function issueError(
  code: DownloadSessionIssuanceErrorCode,
  status: DownloadSessionIssuanceErrorStatus,
): DownloadSessionIssuanceError {
  return new DownloadSessionIssuanceError(code, status);
}

async function boundedPortCall<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(issueError('DOWNLOAD_SESSION_UNAVAILABLE', 503)), timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), expired]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
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

function requireInput(input: IssueDownloadSessionInput): void {
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
    throw issueError('DOWNLOAD_ISSUANCE_REQUEST_INVALID', 400);
  }
}

function safeError(error: unknown): DownloadSessionIssuanceError {
  if (error instanceof DownloadSessionIssuanceError) {
    return error;
  }
  if (error instanceof ResolveVaultError) {
    switch (error.code) {
      case 'SESSION_INVALID':
        return issueError('SESSION_INVALID', 401);
      case 'RESOLVE_VAULT_INVALID':
        return issueError('DOWNLOAD_ISSUANCE_REQUEST_INVALID', 400);
      case 'RESOLVE_VAULT_CONFLICT':
      case 'RESOLVE_VAULT_NOT_FOUND':
        return issueError('DOWNLOAD_CANDIDATE_UNAVAILABLE', 410);
      default:
        return issueError('DOWNLOAD_SESSION_UNAVAILABLE', 503);
    }
  }
  if (error instanceof DownloadSessionClientError) {
    if (error.code === 'DOWNLOAD_SESSION_REQUEST_INVALID') {
      return issueError('DOWNLOAD_ISSUANCE_REQUEST_INVALID', 400);
    }
    if (error.code === 'DOWNLOAD_SESSION_UNAUTHORIZED') {
      return issueError('SESSION_INVALID', 401);
    }
  }
  return issueError('DOWNLOAD_SESSION_UNAVAILABLE', 503);
}

function settleInput(
  input: IssueDownloadSessionInput,
  reservationId: string,
  outcome: ResolvedMediaSettlementInput['outcome'],
): ResolvedMediaSettlementInput {
  return { ...input, reservationId, outcome };
}

function ambiguousSettlement(error: unknown): boolean {
  return !(error instanceof ResolveVaultError) || error.code === 'RESOLVE_VAULT_UNAVAILABLE';
}

async function consumeClaim(
  port: ResolvedMediaIssuancePort,
  input: IssueDownloadSessionInput,
  reservationId: string,
): Promise<void> {
  const consume = settleInput(input, reservationId, 'consume');
  try {
    await boundedPortCall(() => port.settle(consume), DOWNLOAD_SESSION_ISSUANCE_SETTLE_TIMEOUT_MS);
  } catch (error: unknown) {
    if (!ambiguousSettlement(error)) {
      throw error;
    }
    await boundedPortCall(() => port.settle(consume), DOWNLOAD_SESSION_ISSUANCE_SETTLE_TIMEOUT_MS);
  }
}

async function bestEffortReleaseClaim(
  port: ResolvedMediaIssuancePort,
  input: IssueDownloadSessionInput,
  reservationId: string,
): Promise<void> {
  const release = settleInput(input, reservationId, 'release');
  try {
    await boundedPortCall(() => port.settle(release), DOWNLOAD_SESSION_ISSUANCE_SETTLE_TIMEOUT_MS);
  } catch (error: unknown) {
    if (!ambiguousSettlement(error)) {
      return;
    }
    try {
      await boundedPortCall(
        () => port.settle(release),
        DOWNLOAD_SESSION_ISSUANCE_SETTLE_TIMEOUT_MS,
      );
    } catch {
      // Reservation expiry is the final fail-safe for a best-effort rollback.
    }
  }
}

async function rollbackInitializedDownload(
  dependencies: DownloadSessionIssuerDependencies,
  input: IssueDownloadSessionInput,
  claim: ResolvedMediaClaim,
  initialized: InitializedDownloadSession,
): Promise<void> {
  try {
    await boundedPortCall(
      () =>
        dependencies.downloadSessions.destroy({
          downloadId: initialized.downloadId,
          sessionHash: input.identity.sessionHash,
        }),
      DOWNLOAD_SESSION_ISSUANCE_DESTROY_TIMEOUT_MS,
    );
  } catch {
    // An undisclosed cryptographic ID and the absolute expiry remain cleanup safeguards.
  }
  await bestEffortReleaseClaim(dependencies.resolvedMedia, input, claim.reservationId);
}

class BrowserBoundDownloadSessionIssuer implements DownloadSessionIssuer {
  constructor(private readonly dependencies: DownloadSessionIssuerDependencies) {}

  async issue(input: IssueDownloadSessionInput): Promise<IssuedBrowserDownloadSession> {
    requireInput(input);

    let claim: ResolvedMediaClaim;
    try {
      claim = await boundedPortCall(
        () => this.dependencies.resolvedMedia.claim(input),
        DOWNLOAD_SESSION_ISSUANCE_CLAIM_TIMEOUT_MS,
      );
    } catch (error: unknown) {
      throw safeError(error);
    }

    let initialized: InitializedDownloadSession;
    try {
      initialized = await boundedPortCall(
        () =>
          this.dependencies.downloadSessions.initialize({
            sessionHash: input.identity.sessionHash,
            filename: claim.filename,
            shortcode: claim.shortcode,
            media: claim.media,
          }),
        DOWNLOAD_SESSION_ISSUANCE_INITIALIZE_TIMEOUT_MS,
      );
    } catch (error: unknown) {
      await bestEffortReleaseClaim(this.dependencies.resolvedMedia, input, claim.reservationId);
      throw safeError(error);
    }

    try {
      await consumeClaim(this.dependencies.resolvedMedia, input, claim.reservationId);
    } catch (error: unknown) {
      await rollbackInitializedDownload(this.dependencies, input, claim, initialized);
      throw safeError(error);
    }

    return { downloadId: initialized.downloadId, startExpiresAt: initialized.startExpiresAt };
  }
}

export function createDownloadSessionIssuer(
  dependencies: DownloadSessionIssuerDependencies,
): DownloadSessionIssuer {
  return new BrowserBoundDownloadSessionIssuer(dependencies);
}

export function createRemoteDownloadSessionIssuer(bindings: {
  readonly sessions: SessionNamespace;
  readonly downloadSessions: DownloadSessionNamespace;
}): DownloadSessionIssuer {
  return createDownloadSessionIssuer({
    resolvedMedia: {
      claim: (input) =>
        claimResolvedMediaCandidate({
          sessions: bindings.sessions,
          ...input,
        }),
      settle: (input) =>
        settleResolvedMediaClaim({
          sessions: bindings.sessions,
          ...input,
        }),
    },
    downloadSessions: {
      initialize: (input) => initializeDownloadSession(bindings.downloadSessions, input),
      destroy: (input) => destroyDownloadSession(bindings.downloadSessions, input),
    },
  });
}

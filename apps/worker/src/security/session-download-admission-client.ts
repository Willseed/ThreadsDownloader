import { decodeExactRecord } from '@threads-downloader/contracts/strict-json';

import {
  createSessionCoordinatorRequest,
  SESSION_COORDINATOR_ROUTES,
} from '../session-coordinator-protocol.js';
import { createOpaqueId } from './cryptography.js';
import {
  hasCanonicalOpaqueBytes,
  isSessionDownloadId,
  isSessionDownloadPermitId,
  isSessionIdentityHash,
  SESSION_DOWNLOAD_PERMIT_LEASE_MS,
  SESSION_DOWNLOAD_PERMIT_MIN_REMAINING_MS,
} from './session-download-admission.js';
import type { BrowserSessionIdentity, SessionNamespace } from './session-client.js';

export const SESSION_DOWNLOAD_ADMISSION_REQUEST_TIMEOUT_MS = 8_000;

export interface SessionDownloadAdmissionInput {
  readonly session: BrowserSessionIdentity;
  readonly downloadId: string;
}

export interface SessionDownloadAdmission {
  renew(): Promise<void>;
  release(): Promise<void>;
}

export interface SessionDownloadAdmissionPort {
  acquire(input: SessionDownloadAdmissionInput): Promise<SessionDownloadAdmission>;
}

export type SessionDownloadAdmissionErrorCode =
  | 'SESSION_DOWNLOAD_LIMIT'
  | 'SESSION_DOWNLOAD_REQUEST_INVALID'
  | 'SESSION_DOWNLOAD_UNAVAILABLE'
  | 'SESSION_INVALID';

export type SessionDownloadAdmissionErrorStatus = 400 | 401 | 429 | 503;

export class SessionDownloadAdmissionError extends Error {
  constructor(
    readonly code: SessionDownloadAdmissionErrorCode,
    readonly status: SessionDownloadAdmissionErrorStatus,
  ) {
    super(code);
    this.name = 'SessionDownloadAdmissionError';
  }
}

interface SessionDownloadPermitResponse {
  readonly permitId: string;
  readonly sequence: number;
  readonly expiresAt: number;
}

interface SessionStub {
  fetch(request: Request): Promise<Response>;
}

function isSafeTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function decodePermitResponse(
  value: unknown,
  receivedAt: number,
): SessionDownloadPermitResponse | null {
  const record = decodeExactRecord(value, ['expiresAt', 'ok', 'permitId', 'sequence']);
  if (
    record === null ||
    record['ok'] !== true ||
    !isSessionDownloadPermitId(record['permitId']) ||
    !Number.isSafeInteger(record['sequence']) ||
    (record['sequence'] as number) < 0 ||
    !isSafeTimestamp(record['expiresAt']) ||
    !Number.isSafeInteger(receivedAt) ||
    receivedAt < 0 ||
    receivedAt > Number.MAX_SAFE_INTEGER - SESSION_DOWNLOAD_PERMIT_LEASE_MS ||
    record['expiresAt'] < receivedAt + SESSION_DOWNLOAD_PERMIT_MIN_REMAINING_MS ||
    record['expiresAt'] > receivedAt + SESSION_DOWNLOAD_PERMIT_LEASE_MS
  ) {
    return null;
  }
  return {
    permitId: record['permitId'],
    sequence: record['sequence'] as number,
    expiresAt: record['expiresAt'],
  };
}

function decodeAck(value: unknown): boolean {
  return decodeExactRecord(value, ['ok'])?.['ok'] === true;
}

function unavailable(): SessionDownloadAdmissionError {
  return new SessionDownloadAdmissionError('SESSION_DOWNLOAD_UNAVAILABLE', 503);
}

function requestInvalid(): SessionDownloadAdmissionError {
  return new SessionDownloadAdmissionError('SESSION_DOWNLOAD_REQUEST_INVALID', 400);
}

function responseError(response: Response): SessionDownloadAdmissionError {
  if (response.status === 400) {
    return requestInvalid();
  }
  if (response.status === 401) {
    return new SessionDownloadAdmissionError('SESSION_INVALID', 401);
  }
  if (response.status === 429) {
    return new SessionDownloadAdmissionError('SESSION_DOWNLOAD_LIMIT', 429);
  }
  return unavailable();
}

async function boundedFetch(stub: SessionStub, request: Request): Promise<Response> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(unavailable()),
      SESSION_DOWNLOAD_ADMISSION_REQUEST_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([stub.fetch(request), expired]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function requireInput(input: SessionDownloadAdmissionInput): void {
  if (
    typeof input !== 'object' ||
    input === null ||
    typeof input.session !== 'object' ||
    input.session === null ||
    !isSessionDownloadId(input.downloadId) ||
    !isSessionIdentityHash(input.session.sessionHash) ||
    !hasCanonicalOpaqueBytes(input.session.rawId, 43, 32)
  ) {
    throw requestInvalid();
  }
}

function sessionStub(namespace: SessionNamespace, identity: BrowserSessionIdentity): SessionStub {
  try {
    return namespace.get(namespace.idFromName(identity.rawId));
  } catch {
    throw unavailable();
  }
}

async function strictRelease(
  stub: SessionStub,
  binding: {
    readonly sessionHash: string;
    readonly downloadId: string;
    readonly permitId: string;
  },
): Promise<void> {
  let response: Response;
  try {
    response = await boundedFetch(
      stub,
      createSessionCoordinatorRequest(SESSION_COORDINATOR_ROUTES.downloadPermits.release, binding),
    );
  } catch {
    throw unavailable();
  }
  if (response.status !== 200) {
    throw responseError(response);
  }
  if (response.headers.get('content-type') !== 'application/json') {
    throw unavailable();
  }
  try {
    if (!decodeAck(await response.json())) {
      throw unavailable();
    }
  } catch (error: unknown) {
    if (error instanceof SessionDownloadAdmissionError) {
      throw error;
    }
    throw unavailable();
  }
}

async function bestEffortRelease(
  stub: SessionStub,
  binding: {
    readonly sessionHash: string;
    readonly downloadId: string;
    readonly permitId: string;
  },
): Promise<void> {
  try {
    await strictRelease(stub, binding);
  } catch {
    // Permit expiry and the coordinator alarm remain the fail-safe cleanup path.
  }
}

class RemoteSessionDownloadAdmission implements SessionDownloadAdmission {
  private sequence: number;
  private tail: Promise<void> = Promise.resolve();
  private released = false;
  private releasePromise: Promise<void> | null = null;

  constructor(
    private readonly stub: SessionStub,
    private readonly binding: {
      readonly sessionHash: string;
      readonly downloadId: string;
      readonly permitId: string;
    },
    sequence: number,
    private readonly clock: () => number,
  ) {
    this.sequence = sequence;
  }

  async renew(): Promise<void> {
    if (this.released) {
      throw unavailable();
    }
    const renewal = this.tail.then(async () => {
      const sequence = this.sequence + 1;
      let response: Response;
      try {
        response = await boundedFetch(
          this.stub,
          createSessionCoordinatorRequest(SESSION_COORDINATOR_ROUTES.downloadPermits.renew, {
            ...this.binding,
            sequence,
          }),
        );
      } catch {
        throw unavailable();
      }
      if (response.status !== 200) {
        throw responseError(response);
      }
      if (response.headers.get('content-type') !== 'application/json') {
        throw unavailable();
      }
      let receivedAt: number;
      try {
        receivedAt = this.clock();
      } catch {
        throw unavailable();
      }
      let decoded: SessionDownloadPermitResponse | null;
      try {
        decoded = decodePermitResponse(await response.json(), receivedAt);
      } catch {
        decoded = null;
      }
      if (decoded?.permitId !== this.binding.permitId || decoded?.sequence !== sequence) {
        throw unavailable();
      }
      this.sequence = decoded.sequence;
    });
    this.tail = renewal.catch(() => undefined);
    return renewal;
  }

  release(): Promise<void> {
    if (this.releasePromise !== null) {
      return this.releasePromise;
    }
    this.released = true;
    this.releasePromise = bestEffortRelease(this.stub, this.binding);
    return this.releasePromise;
  }
}

export async function acquireSessionDownloadAdmission(
  namespace: SessionNamespace,
  input: SessionDownloadAdmissionInput,
  clock: () => number = Date.now,
): Promise<SessionDownloadAdmission> {
  requireInput(input);
  let permitId: string;
  try {
    permitId = createOpaqueId(192);
  } catch {
    throw unavailable();
  }
  const stub = sessionStub(namespace, input.session);
  const binding = {
    sessionHash: input.session.sessionHash,
    downloadId: input.downloadId,
    permitId,
  };
  let response: Response;
  try {
    response = await boundedFetch(
      stub,
      createSessionCoordinatorRequest(SESSION_COORDINATOR_ROUTES.downloadPermits.acquire, binding),
    );
  } catch {
    await bestEffortRelease(stub, binding);
    throw unavailable();
  }
  if (response.status !== 201) {
    const error = responseError(response);
    if (![400, 401, 429].includes(response.status)) {
      await bestEffortRelease(stub, binding);
    }
    throw error;
  }
  if (response.headers.get('content-type') !== 'application/json') {
    await bestEffortRelease(stub, binding);
    throw unavailable();
  }
  let receivedAt: number;
  try {
    receivedAt = clock();
  } catch {
    await bestEffortRelease(stub, binding);
    throw unavailable();
  }
  let decoded: SessionDownloadPermitResponse | null;
  try {
    decoded = decodePermitResponse(await response.json(), receivedAt);
  } catch {
    decoded = null;
  }
  if (decoded?.permitId !== permitId || decoded?.sequence !== 0) {
    await bestEffortRelease(stub, binding);
    throw unavailable();
  }
  return new RemoteSessionDownloadAdmission(stub, binding, decoded.sequence, clock);
}

export function createSessionDownloadAdmissionPort(
  namespace: SessionNamespace,
  clock: () => number = Date.now,
): SessionDownloadAdmissionPort {
  return {
    acquire: (input) => acquireSessionDownloadAdmission(namespace, input, clock),
  };
}

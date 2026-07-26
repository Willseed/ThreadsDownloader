import {
  acquireDownloadSessionStream,
  encodeDownloadHeaderEvidence,
  finishDownloadSessionStream,
  inspectDownloadSession,
  interruptDownloadSessionStream,
  renewDownloadSessionStream,
  type AcquiredDownloadStream,
  type DownloadSessionMetadataSnapshot,
  type DownloadSessionNamespace,
} from '../security/download-session-client.js';
import type {
  SessionDownloadAdmission,
  SessionDownloadAdmissionPort,
} from '../security/session-download-admission-client.js';
import type { BrowserSessionIdentity } from '../security/session-client.js';
import { createTransferPlan, type TransferPlan } from '../security/range-transfer.js';
import {
  decideRedirect,
  parseCdnUrl,
  upstreamHeaders,
  type CdnUrl,
} from '../security/upstream-policy.js';

const HEARTBEAT_INTERVAL_MS = 30_000;
export const DOWNLOAD_LIFECYCLE_MUTATION_TIMEOUT_MS = 8_000;
const UPSTREAM_HEADER_TIMEOUT_MS = 8_000;
const VIDEO_MEDIA_TYPE = /^video\/[!#$%&'*+.^_`|~A-Za-z0-9-]+$/u;

export interface DownloadDeliveryInput {
  readonly session: BrowserSessionIdentity;
  readonly downloadId: string;
  readonly rangeHeader: string | null;
  readonly ifRangeHeader: string | null;
}

export interface DownloadDeliveryDependencies {
  readonly fetcher: (request: Request) => Promise<Response>;
  readonly sessions: DownloadSessionNamespace;
  readonly admissions: SessionDownloadAdmissionPort;
}

export type DownloadDelivery = (input: DownloadDeliveryInput) => Promise<Response>;

export type DownloadDeliveryErrorCode = 'DOWNLOAD_ORIGIN_INVALID' | 'DOWNLOAD_ORIGIN_UNAVAILABLE';

export class DownloadDeliveryError extends Error {
  constructor(readonly code: DownloadDeliveryErrorCode) {
    super(code);
    this.name = 'DownloadDeliveryError';
  }
}

interface OriginTransfer {
  readonly response: Response;
  readonly plan: TransferPlan;
}

function fail(code: DownloadDeliveryErrorCode): never {
  throw new DownloadDeliveryError(code);
}

async function boundedLifecycleMutation<T>(operation: () => Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error('DOWNLOAD_LIFECYCLE_MUTATION_TIMEOUT')),
      DOWNLOAD_LIFECYCLE_MUTATION_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([operation(), expired]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function normalizedVideoType(headers: Headers): string {
  const value = headers.get('content-type');
  if (value === null || value.includes(',')) {
    return fail('DOWNLOAD_ORIGIN_INVALID');
  }
  const separator = value.indexOf(';');
  const normalized = value
    .slice(0, separator === -1 ? value.length : separator)
    .trim()
    .toLowerCase();
  return VIDEO_MEDIA_TYPE.test(normalized) && normalized !== 'video/*'
    ? normalized
    : fail('DOWNLOAD_ORIGIN_INVALID');
}

function createOriginRequest(
  target: CdnUrl,
  acquired: AcquiredDownloadStream,
  signal: AbortSignal,
): Request {
  const headers = upstreamHeaders();
  headers.set('accept-encoding', 'identity');
  const requested = acquired.request.requestedInterval;
  if (requested !== null) {
    const pin = acquired.request.representationPin;
    headers.set('range', `bytes=${String(requested.start)}-${String(requested.end)}`);
    if (pin !== null) {
      headers.set('if-range', pin.validator.value);
    }
  }
  return new Request(target.url.href, {
    method: 'GET',
    credentials: 'omit',
    headers,
    redirect: 'manual',
    referrer: '',
    referrerPolicy: 'no-referrer',
    signal,
  });
}

async function fetchOnce(
  target: CdnUrl,
  acquired: AcquiredDownloadStream,
  fetcher: DownloadDeliveryDependencies['fetcher'],
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_HEADER_TIMEOUT_MS);
  try {
    return await fetcher(createOriginRequest(target, acquired, controller.signal));
  } catch {
    return fail('DOWNLOAD_ORIGIN_UNAVAILABLE');
  } finally {
    clearTimeout(timeout);
  }
}

async function cancelResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Origin cancellation is best-effort and never changes the public failure.
  }
}

async function fetchTerminalResponse(
  acquired: AcquiredDownloadStream,
  fetcher: DownloadDeliveryDependencies['fetcher'],
): Promise<Response> {
  let target: CdnUrl;
  try {
    target = parseCdnUrl(acquired.media.finalUrl.url.href);
  } catch {
    return fail('DOWNLOAD_ORIGIN_INVALID');
  }
  let redirectCount = 0;
  while (true) {
    const response = await fetchOnce(target, acquired, fetcher);
    let redirected: CdnUrl | undefined;
    let decision;
    try {
      decision = decideRedirect({
        status: response.status,
        location: response.headers.get('location'),
        currentUrl: target.url.href,
        redirectCount,
        validateTarget(value) {
          redirected = parseCdnUrl(value);
        },
      });
    } catch {
      void cancelResponse(response);
      return fail('DOWNLOAD_ORIGIN_INVALID');
    }
    if (decision.kind === 'stop') {
      return response;
    }
    void cancelResponse(response);
    if (redirected === undefined) {
      return fail('DOWNLOAD_ORIGIN_INVALID');
    }
    target = redirected;
    redirectCount = decision.redirectCount;
  }
}

function validateOriginTransfer(
  response: Response,
  acquired: AcquiredDownloadStream,
): OriginTransfer {
  const requested = acquired.request.requestedInterval;
  if (
    (response.status !== 200 && response.status !== 206) ||
    (requested === null && response.status !== 200) ||
    (response.status === 200 && response.headers.get('content-range') !== null) ||
    ![null, 'identity'].includes(response.headers.get('content-encoding')) ||
    response.body === null ||
    normalizedVideoType(response.headers) !== acquired.media.contentType
  ) {
    return fail('DOWNLOAD_ORIGIN_INVALID');
  }
  let plan: TransferPlan;
  try {
    plan = createTransferPlan({
      status: response.status,
      headers: response.headers,
      ...(requested === null ? {} : { requested }),
      ...(acquired.request.representationPin === null
        ? {}
        : { pin: acquired.request.representationPin }),
    });
  } catch {
    return fail('DOWNLOAD_ORIGIN_INVALID');
  }
  if (plan.expectedBytes === 0) {
    return fail('DOWNLOAD_ORIGIN_INVALID');
  }
  return { response, plan };
}

function responseHeaders(
  metadata: DownloadSessionMetadataSnapshot,
  acquired: AcquiredDownloadStream,
  transfer: OriginTransfer,
): Headers {
  const { plan } = transfer;
  const headers = new Headers({
    'cache-control': 'no-store',
    'content-disposition': `attachment; filename="${metadata.filename}"`,
    'content-type': acquired.media.contentType,
  });
  if (transfer.response.status === 206 || acquired.media.rangeCapability === 'bytes') {
    headers.set('accept-ranges', 'bytes');
  } else if (acquired.media.rangeCapability === 'none') {
    headers.set('accept-ranges', 'none');
  }
  if (plan.expectedBytes !== null) {
    headers.set('content-length', String(plan.expectedBytes));
  }
  if (transfer.response.status === 206 && plan.end !== null && plan.total !== null) {
    headers.set(
      'content-range',
      `bytes ${String(plan.start)}-${String(plan.end)}/${String(plan.total)}`,
    );
  }
  if (plan.validator?.kind === 'etag') {
    headers.set('etag', plan.validator.value);
  } else if (plan.validator?.kind === 'last-modified') {
    headers.set('last-modified', plan.validator.value);
  }
  return headers;
}

class LeaseTrackedStream {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private acknowledgedBytes = 0;
  private actualBytes = 0;
  private downstreamCancelled = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private attemptedSequence: number;
  private sequence: number;
  private renewInFlight: Promise<void> | null = null;
  private terminalInFlight: Promise<void> | null = null;
  private terminalKind: 'finish' | 'interrupt' | null = null;

  constructor(
    private readonly acquired: AcquiredDownloadStream,
    private readonly admission: SessionDownloadAdmission,
    private readonly transfer: OriginTransfer,
    private readonly identity: { readonly downloadId: string; readonly sessionHash: string },
    private readonly dependencies: DownloadDeliveryDependencies,
  ) {
    this.reader = transfer.response.body!.getReader();
    this.attemptedSequence = acquired.sequence;
    this.sequence = acquired.sequence;
  }

  readable(): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>(
      {
        start: (controller) => this.startHeartbeat(controller),
        pull: (controller) => this.pull(controller),
        cancel: () => this.cancel(),
      },
      { highWaterMark: 0 },
    );
  }

  private startHeartbeat(controller: ReadableStreamDefaultController<Uint8Array>): void {
    if (this.heartbeatTimer !== null || this.terminalKind !== null) {
      return;
    }
    this.heartbeatTimer = setInterval(() => {
      void this.renewLease().catch(() => this.handleHeartbeatFailure(controller));
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async renewLease(): Promise<void> {
    if (this.terminalKind !== null) {
      return;
    }
    if (this.renewInFlight === null) {
      const sequence = this.sequence + 1;
      const bytesAtAttempt = this.actualBytes;
      const progress = bytesAtAttempt > this.acknowledgedBytes;
      this.attemptedSequence = sequence;
      this.renewInFlight = Promise.allSettled([
        boundedLifecycleMutation(() => this.admission.renew()),
        boundedLifecycleMutation(() =>
          renewDownloadSessionStream(this.dependencies.sessions, {
            ...this.identity,
            holderId: this.acquired.holderId,
            sequence,
            progress,
          }),
        ),
      ])
        .then((results) => {
          const downloadRenewal = results[1];
          if (downloadRenewal.status === 'fulfilled') {
            this.sequence = downloadRenewal.value.sequence;
            this.acknowledgedBytes = Math.max(this.acknowledgedBytes, bytesAtAttempt);
          }
          const failure = results.find(
            (result): result is PromiseRejectedResult => result.status === 'rejected',
          );
          if (failure !== undefined) {
            throw failure.reason;
          }
        })
        .finally(() => {
          this.renewInFlight = null;
        });
    }
    await this.renewInFlight;
  }

  private async interruptLease(): Promise<void> {
    for (const sequence of this.terminalSequenceCandidates()) {
      try {
        await boundedLifecycleMutation(() =>
          interruptDownloadSessionStream(this.dependencies.sessions, {
            ...this.identity,
            holderId: this.acquired.holderId,
            sequence,
          }),
        );
        return;
      } catch {
        // An ambiguous renewal may require the other locally known sequence.
      }
    }
    // Lease expiry and the DO alarm remain the fail-safe cleanup path.
  }

  private terminalSequenceCandidates(): readonly number[] {
    return this.attemptedSequence === this.sequence
      ? [this.sequence]
      : [this.sequence, this.attemptedSequence];
  }

  private async finishLease(): Promise<void> {
    let failure: unknown;
    for (const sequence of this.terminalSequenceCandidates()) {
      try {
        await boundedLifecycleMutation(() =>
          finishDownloadSessionStream(this.dependencies.sessions, {
            ...this.identity,
            holderId: this.acquired.holderId,
            sequence,
            normalEof: true,
            actualBytes: this.actualBytes,
            upstream: {
              status: this.transfer.response.status as 200 | 206,
              headers: encodeDownloadHeaderEvidence(this.transfer.response.headers),
            },
          }),
        );
        this.sequence = sequence;
        return;
      } catch (error: unknown) {
        failure = error;
      }
    }
    throw failure;
  }

  private async terminate(kind: 'finish' | 'interrupt'): Promise<void> {
    if (this.terminalInFlight !== null) {
      return this.terminalInFlight;
    }
    this.terminalKind = kind;
    this.stopHeartbeat();
    this.terminalInFlight = (async () => {
      try {
        const pendingRenewal = this.renewInFlight;
        if (pendingRenewal !== null) {
          try {
            await pendingRenewal;
          } catch {
            // The latest independently acknowledged sequences remain authoritative.
          }
        }
        if (kind === 'finish') {
          try {
            await this.finishLease();
          } catch (error: unknown) {
            await this.interruptLease();
            throw error;
          }
          return;
        }
        await this.interruptLease();
      } finally {
        try {
          await boundedLifecycleMutation(() => this.admission.release());
        } catch {
          // Admission release is best-effort and cannot replace the transfer result.
        }
      }
    })();
    return this.terminalInFlight;
  }

  private releaseReader(): void {
    try {
      this.reader.releaseLock();
    } catch {
      // A pending read retains the lock until origin cancellation settles.
    }
  }

  private async cancelOrigin(): Promise<void> {
    try {
      await this.reader.cancel();
    } catch {
      // Origin cancellation is best-effort.
    }
    this.releaseReader();
  }

  private errorDownstream(controller: ReadableStreamDefaultController<Uint8Array>): void {
    if (this.downstreamCancelled) {
      return;
    }
    try {
      controller.error(new Error('DOWNLOAD_STREAM_FAILED'));
    } catch {
      // A downstream cancellation owns the terminal stream state.
    }
  }

  private closeDownstream(controller: ReadableStreamDefaultController<Uint8Array>): void {
    if (this.downstreamCancelled) {
      return;
    }
    try {
      controller.close();
    } catch {
      // A downstream cancellation owns the terminal stream state.
    }
  }

  private async interruptAndCancelOrigin(): Promise<void> {
    const interruption = this.terminate('interrupt');
    void this.cancelOrigin();
    await interruption;
  }

  private async failStream(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    await this.interruptAndCancelOrigin();
    this.errorDownstream(controller);
  }

  private async handleHeartbeatFailure(
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): Promise<void> {
    if (this.terminalKind === null) {
      await this.failStream(controller);
    }
  }

  private async finishAtEof(
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): Promise<void> {
    this.releaseReader();
    const expected = this.transfer.plan.expectedBytes;
    if ((expected !== null && this.actualBytes !== expected) || this.actualBytes === 0) {
      await this.terminate('interrupt');
      this.errorDownstream(controller);
      return;
    }
    if (expected === null) {
      await this.terminate('interrupt');
      this.closeDownstream(controller);
      return;
    }
    try {
      await this.terminate('finish');
      this.closeDownstream(controller);
    } catch {
      this.errorDownstream(controller);
    }
  }

  private async forwardChunk(
    chunk: Uint8Array,
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): Promise<void> {
    const nextBytes = this.actualBytes + chunk.byteLength;
    const expected = this.transfer.plan.expectedBytes;
    if (!Number.isSafeInteger(nextBytes) || (expected !== null && nextBytes > expected)) {
      await this.failStream(controller);
      return;
    }
    this.actualBytes = nextBytes;
    controller.enqueue(chunk);
  }

  private async handlePullFailure(
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): Promise<void> {
    if (this.terminalKind === null) {
      await this.failStream(controller);
    } else if (this.terminalKind === 'finish' && !this.downstreamCancelled) {
      try {
        await this.terminalInFlight;
      } catch {
        this.errorDownstream(controller);
      }
    }
  }

  private async pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    if (this.terminalKind !== null) {
      return;
    }
    try {
      const result = await this.reader.read();
      if (this.terminalKind !== null) {
        return;
      }
      if (result.done) {
        await this.finishAtEof(controller);
        return;
      }
      if (!(result.value instanceof Uint8Array)) {
        await this.failStream(controller);
        return;
      }
      await this.forwardChunk(result.value, controller);
    } catch {
      await this.handlePullFailure(controller);
    }
  }

  private async cancel(): Promise<void> {
    this.downstreamCancelled = true;
    if (this.terminalKind !== null) {
      try {
        await this.terminalInFlight;
      } catch {
        // The response is already cancelled; lifecycle cleanup remains best-effort.
      }
      return;
    }
    await this.interruptAndCancelOrigin();
  }
}

async function interruptAcquired(
  dependencies: DownloadDeliveryDependencies,
  acquired: AcquiredDownloadStream,
  identity: { readonly downloadId: string; readonly sessionHash: string },
): Promise<void> {
  try {
    await boundedLifecycleMutation(() =>
      interruptDownloadSessionStream(dependencies.sessions, {
        ...identity,
        holderId: acquired.holderId,
        sequence: acquired.sequence,
      }),
    );
  } catch {
    // Lease expiry and the DO alarm remain the fail-safe cleanup path.
  }
}

async function releaseAdmission(admission: SessionDownloadAdmission): Promise<void> {
  try {
    await boundedLifecycleMutation(() => admission.release());
  } catch {
    // Admission expiry and the coordinator alarm remain the fail-safe cleanup path.
  }
}

export function createDownloadDelivery(
  dependencies: DownloadDeliveryDependencies,
): DownloadDelivery {
  return async (input): Promise<Response> => {
    const identity = { downloadId: input.downloadId, sessionHash: input.session.sessionHash };
    const metadata = await inspectDownloadSession(dependencies.sessions, identity);
    const admission = await dependencies.admissions.acquire({
      session: input.session,
      downloadId: input.downloadId,
    });
    let acquired: AcquiredDownloadStream;
    try {
      acquired = await acquireDownloadSessionStream(dependencies.sessions, {
        ...identity,
        rangeHeader: input.rangeHeader,
        ifRangeHeader: input.ifRangeHeader,
      });
    } catch (error: unknown) {
      await releaseAdmission(admission);
      throw error;
    }
    let response: Response | null = null;
    try {
      response = await fetchTerminalResponse(acquired, dependencies.fetcher);
      const transfer = validateOriginTransfer(response, acquired);
      await boundedLifecycleMutation(() => admission.renew());
      const body = new LeaseTrackedStream(
        acquired,
        admission,
        transfer,
        identity,
        dependencies,
      ).readable();
      return new Response(body, {
        status: response.status,
        headers: responseHeaders(metadata, acquired, transfer),
      });
    } catch (error: unknown) {
      const cleanup = Promise.all([
        interruptAcquired(dependencies, acquired, identity),
        releaseAdmission(admission),
      ]);
      if (response !== null) {
        void cancelResponse(response);
      }
      await cleanup;
      throw error;
    }
  };
}

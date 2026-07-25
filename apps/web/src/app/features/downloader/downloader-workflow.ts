import { inject, Injectable, signal, type Signal } from '@angular/core';
import { type ResolveCandidate, type SessionResponse } from '@threads-downloader/contracts';
import { firstValueFrom } from 'rxjs';

import {
  DownloaderApi,
  DownloaderApiError,
  type DownloaderApiErrorCode,
} from '../../core/api/downloader-api.js';
import {
  BrowserDownloadHandoff,
  DOWNLOAD_HANDOFF_MESSAGE,
} from '../../core/download/browser-download-handoff.js';

const GENERIC_ERROR_MESSAGE = '服務暫時無法使用，請稍後再試。';
const RESOLVE_REQUIREMENTS_MESSAGE = '請確認權利、網址與驗證狀態後再試。';
const CANDIDATE_INVALID_MESSAGE = '下載候選無效，請重新解析貼文。';

export interface DownloaderChallengeHandle {
  readonly token: Signal<string | null>;
  reset(): void;
}

export type DownloaderWorkflowState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'bootstrapping' }
  | { readonly kind: 'ready'; readonly siteKey: string }
  | { readonly kind: 'resolving'; readonly siteKey: string }
  | {
      readonly kind: 'candidates';
      readonly siteKey: string;
      readonly candidates: readonly ResolveCandidate[];
    }
  | {
      readonly kind: 'issuing';
      readonly siteKey: string;
      readonly candidates: readonly ResolveCandidate[];
    }
  | {
      readonly kind: 'handed-off';
      readonly siteKey: string;
      readonly candidates: readonly ResolveCandidate[];
      readonly message: typeof DOWNLOAD_HANDOFF_MESSAGE;
    }
  | {
      readonly kind: 'error';
      readonly siteKey: string | null;
      readonly code: DownloaderApiErrorCode;
      readonly message: string;
      readonly requestId: string | null;
      readonly candidates?: readonly ResolveCandidate[];
    };

function safeCandidates(candidates: readonly ResolveCandidate[]): readonly ResolveCandidate[] {
  return Object.freeze(
    candidates.map((candidate) =>
      Object.freeze({
        candidateId: candidate.candidateId,
        filename: candidate.filename,
        ...(candidate.contentLength === undefined
          ? {}
          : { contentLength: candidate.contentLength }),
        ...(candidate.width === undefined ? {} : { width: candidate.width }),
        ...(candidate.height === undefined ? {} : { height: candidate.height }),
        ...(candidate.duration === undefined ? {} : { duration: candidate.duration }),
      }),
    ),
  );
}

function safeError(
  reason: unknown,
  siteKey: string | null,
  candidates?: readonly ResolveCandidate[],
): Extract<DownloaderWorkflowState, { readonly kind: 'error' }> {
  const context = candidates === undefined ? {} : { candidates };
  if (reason instanceof DownloaderApiError) {
    return {
      kind: 'error',
      siteKey,
      code: reason.code,
      message: reason.message,
      requestId: reason.requestId,
      ...context,
    };
  }
  return {
    kind: 'error',
    siteKey,
    code: 'CLIENT_UNAVAILABLE',
    message: GENERIC_ERROR_MESSAGE,
    requestId: null,
    ...context,
  };
}

function downloadableCandidates(
  state: DownloaderWorkflowState,
): readonly ResolveCandidate[] | null {
  if (state.kind === 'candidates' || state.kind === 'handed-off') {
    return state.candidates;
  }
  return state.kind === 'error' ? (state.candidates ?? null) : null;
}

@Injectable()
export class DownloaderWorkflow {
  private readonly api = inject(DownloaderApi);
  private readonly handoff = inject(BrowserDownloadHandoff);
  private readonly stateValue = signal<DownloaderWorkflowState>({ kind: 'idle' });

  private session: SessionResponse | null = null;
  private resolveId: string | null = null;
  private pendingHandoff: { readonly candidateId: string; readonly downloadUrl: string } | null =
    null;
  private challenge: DownloaderChallengeHandle | null = null;
  private generation = 0;
  private destroyed = false;

  readonly state = this.stateValue.asReadonly();

  async bootstrap(): Promise<void> {
    if (this.destroyed) {
      return;
    }
    const current = this.stateValue();
    if (
      current.kind === 'bootstrapping' ||
      current.kind === 'resolving' ||
      current.kind === 'issuing'
    ) {
      return;
    }
    const generation = this.invalidatePending();
    this.resetChallenge();
    this.session = null;
    this.resolveId = null;
    this.pendingHandoff = null;
    this.stateValue.set({ kind: 'bootstrapping' });

    try {
      const session = await firstValueFrom(this.api.getSession());
      if (!this.isCurrent(generation)) {
        return;
      }
      this.session = session;
      this.stateValue.set({ kind: 'ready', siteKey: session.turnstileSiteKey });
    } catch (reason: unknown) {
      if (!this.isCurrent(generation)) {
        return;
      }
      this.stateValue.set(safeError(reason, null));
    }
  }

  attachChallenge(handle: DownloaderChallengeHandle): void {
    if (this.destroyed) {
      this.tryReset(handle);
      return;
    }
    if (this.challenge !== handle) {
      this.resetChallenge();
      this.challenge = handle;
    }
  }

  async resolve(postUrl: string, rightsConfirmed: boolean): Promise<void> {
    if (this.destroyed) {
      return;
    }
    const current = this.stateValue();
    if (
      current.kind === 'bootstrapping' ||
      current.kind === 'resolving' ||
      current.kind === 'issuing'
    ) {
      return;
    }
    const session = this.session;
    const challenge = this.challenge;
    const token = challenge?.token() ?? null;
    const allowedState =
      current.kind === 'ready' ||
      current.kind === 'candidates' ||
      current.kind === 'handed-off' ||
      current.kind === 'error';
    if (
      !allowedState ||
      session === null ||
      challenge === null ||
      token === null ||
      token.trim().length === 0 ||
      rightsConfirmed !== true ||
      postUrl.trim().length === 0
    ) {
      this.rejectOperation(RESOLVE_REQUIREMENTS_MESSAGE);
      return;
    }

    const generation = this.invalidatePending();
    this.resolveId = null;
    this.pendingHandoff = null;
    if (!this.resetChallenge()) {
      this.stateValue.set(safeError(null, session.turnstileSiteKey));
      return;
    }
    this.stateValue.set({ kind: 'resolving', siteKey: session.turnstileSiteKey });

    try {
      const response = await firstValueFrom(
        this.api.resolve({
          postUrl: postUrl.trim(),
          csrfToken: session.csrfToken,
          turnstileToken: token,
          rightsConfirmed: true,
        }),
      );
      if (!this.isCurrent(generation)) {
        return;
      }
      const candidates = safeCandidates(response.candidates);
      this.resolveId = response.resolveId;
      this.stateValue.set({
        kind: 'candidates',
        siteKey: session.turnstileSiteKey,
        candidates,
      });
    } catch (reason: unknown) {
      if (!this.isCurrent(generation)) {
        return;
      }
      this.stateValue.set(safeError(reason, session.turnstileSiteKey));
    }
  }

  async download(candidateId: string): Promise<void> {
    if (this.destroyed) {
      return;
    }
    const current = this.stateValue();
    if (
      current.kind === 'bootstrapping' ||
      current.kind === 'resolving' ||
      current.kind === 'issuing'
    ) {
      return;
    }
    const candidates = downloadableCandidates(current);
    const session = this.session;
    const resolveId = this.resolveId;
    if (
      candidates === null ||
      session === null ||
      resolveId === null ||
      !candidates.some((candidate) => candidate.candidateId === candidateId)
    ) {
      this.rejectOperation(CANDIDATE_INVALID_MESSAGE, candidates ?? undefined);
      return;
    }

    const generation = this.invalidatePending();
    const retryUrl =
      this.pendingHandoff?.candidateId === candidateId ? this.pendingHandoff.downloadUrl : null;
    if (retryUrl === null) {
      this.pendingHandoff = null;
    }
    this.stateValue.set({
      kind: 'issuing',
      siteKey: session.turnstileSiteKey,
      candidates,
    });

    try {
      let downloadUrl = retryUrl;
      if (downloadUrl === null) {
        const response = await firstValueFrom(
          this.api.createDownloadSession({
            resolveId,
            candidateId,
            csrfToken: session.csrfToken,
          }),
        );
        if (!this.isCurrent(generation)) {
          return;
        }
        downloadUrl = response.downloadUrl;
        this.pendingHandoff = { candidateId, downloadUrl };
      }
      this.handoff.handoff(downloadUrl);
      if (!this.isCurrent(generation)) {
        return;
      }
      this.stateValue.set({
        kind: 'handed-off',
        siteKey: session.turnstileSiteKey,
        candidates,
        message: DOWNLOAD_HANDOFF_MESSAGE,
      });
    } catch (reason: unknown) {
      if (!this.isCurrent(generation)) {
        return;
      }
      this.stateValue.set(safeError(reason, session.turnstileSiteKey, candidates));
    }
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.generation += 1;
    this.resetChallenge();
    this.challenge = null;
    this.session = null;
    this.resolveId = null;
    this.pendingHandoff = null;
    this.stateValue.set({ kind: 'idle' });
  }

  private invalidatePending(): number {
    this.generation += 1;
    return this.generation;
  }

  private isCurrent(generation: number): boolean {
    return !this.destroyed && this.generation === generation;
  }

  private rejectOperation(message: string, candidates?: readonly ResolveCandidate[]): void {
    this.generation += 1;
    this.stateValue.set({
      kind: 'error',
      siteKey: this.session?.turnstileSiteKey ?? null,
      code: 'CLIENT_REQUEST_INVALID',
      message,
      requestId: null,
      ...(candidates === undefined ? {} : { candidates }),
    });
  }

  private resetChallenge(): boolean {
    const challenge = this.challenge;
    if (challenge === null) {
      return true;
    }
    if (this.tryReset(challenge)) {
      return true;
    }
    this.challenge = null;
    return false;
  }

  private tryReset(handle: DownloaderChallengeHandle): boolean {
    try {
      handle.reset();
      return true;
    } catch {
      return false;
    }
  }
}

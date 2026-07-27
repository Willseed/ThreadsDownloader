import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  type OnDestroy,
  untracked,
  viewChild,
} from '@angular/core';
import {
  AbstractControl,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  Validators,
  type ValidationErrors,
  type ValidatorFn,
} from '@angular/forms';
import { type ResolveCandidate } from '@threads-downloader/contracts';

import {
  TURNSTILE_CHALLENGE,
  type TurnstileWidgetHandle,
} from '../../core/turnstile/browser-turnstile-challenge.js';
import { LegalModalTriggerDirective } from '../legal/legal-modal.js';
import { DownloaderWorkflow, type DownloaderWorkflowState } from './downloader-workflow.js';

const THREADS_HOSTS = new Set(['threads.com', 'www.threads.com', 'threads.net', 'www.threads.net']);
const THREADS_POST_PATH = /^\/@[A-Za-z0-9._]{1,30}\/post\/[A-Za-z0-9_-]{5,64}\/?$/u;
const MAX_THREADS_URL_LENGTH = 2_048;

export const threadsPostUrlValidator: ValidatorFn = (
  control: AbstractControl<unknown>,
): ValidationErrors | null => {
  if (typeof control.value !== 'string' || control.value.trim() === '') {
    return null;
  }
  const candidate = control.value.trim();
  if (candidate.length > MAX_THREADS_URL_LENGTH) {
    return { threadsPostUrl: true };
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { threadsPostUrl: true };
  }
  if (
    parsed.protocol !== 'https:' ||
    !THREADS_HOSTS.has(parsed.hostname) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== '' ||
    parsed.hash !== '' ||
    /%/iu.test(parsed.pathname) ||
    !THREADS_POST_PATH.test(parsed.pathname)
  ) {
    return { threadsPostUrl: true };
  }
  return null;
};

function siteKeyFrom(state: DownloaderWorkflowState): string | null {
  return state.kind === 'idle' || state.kind === 'bootstrapping' ? null : state.siteKey;
}

function candidatesFrom(state: DownloaderWorkflowState): readonly ResolveCandidate[] {
  if (state.kind === 'candidates' || state.kind === 'issuing' || state.kind === 'handed-off') {
    return state.candidates;
  }
  return state.kind === 'error' ? (state.candidates ?? []) : [];
}

function statusText(state: DownloaderWorkflowState): string | null {
  switch (state.kind) {
    case 'idle':
    case 'ready':
    case 'candidates':
    case 'error':
      return null;
    case 'bootstrapping':
      return '正在建立安全工作階段……';
    case 'resolving':
      return '正在解析公開貼文……';
    case 'issuing':
    case 'handed-off':
      return null;
  }
}

@Component({
  selector: 'app-downloader-page',
  imports: [LegalModalTriggerDirective, ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main id="main-content" class="downloader-page" aria-labelledby="page-title">
      <header class="hero">
        <h1 id="page-title">下載公開 Threads 影片</h1>
        <p class="hero-copy">貼上貼文網址，驗證後選擇影片版本。</p>
      </header>

      <section id="download-workflow" class="workbench" aria-label="取得影片">
        <form
          [formGroup]="form"
          [attr.aria-busy]="busy() ? 'true' : null"
          (ngSubmit)="submit()"
          novalidate
        >
          <div class="field">
            <label for="post-url">Threads 貼文網址</label>
            <input
              #postUrlInput
              id="post-url"
              type="url"
              inputmode="url"
              autocomplete="url"
              spellcheck="false"
              formControlName="postUrl"
              placeholder="https://www.threads.com/@username/post/shortcode"
              [attr.aria-invalid]="
                form.controls.postUrl.invalid && form.controls.postUrl.touched ? 'true' : null
              "
              [attr.aria-describedby]="
                form.controls.postUrl.invalid && form.controls.postUrl.touched
                  ? 'post-url-help post-url-error'
                  : 'post-url-help'
              "
              required
            />
            <p id="post-url-help" class="field-help">支援 threads.com 與 threads.net</p>
            @if (form.controls.postUrl.invalid && form.controls.postUrl.touched) {
              <p id="post-url-error" class="field-error" role="alert">
                請輸入有效的公開 Threads 貼文網址。
              </p>
            }
          </div>

          <div class="rights-block">
            <label class="rights-confirmation">
              <input
                #rightsConfirmedInput
                id="rights-confirmed"
                type="checkbox"
                formControlName="rightsConfirmed"
                [attr.aria-invalid]="
                  form.controls.rightsConfirmed.invalid && form.controls.rightsConfirmed.touched
                    ? 'true'
                    : null
                "
                [attr.aria-describedby]="
                  form.controls.rightsConfirmed.invalid && form.controls.rightsConfirmed.touched
                    ? 'rights-detail rights-error'
                    : 'rights-detail'
                "
                required
              />
              <span id="rights-help">我確認我有權下載及使用此內容</span>
            </label>
            <p id="rights-detail" class="visually-hidden">
              我確認我擁有內容、已取得授權，或依適用法律得以保存；我了解學術或非商業目的本身不構成授權，並自行負責遵守法律與平台條款。
            </p>
            <a class="rights-detail-link" href="/terms" legalModalTrigger="terms"
              >查看內容使用責任</a
            >
          </div>
          @if (form.controls.rightsConfirmed.invalid && form.controls.rightsConfirmed.touched) {
            <p id="rights-error" class="field-error" role="alert">必須先確認內容使用權利。</p>
          }

          <div
            #challengeRegion
            #turnstileContainer
            class="turnstile-container"
            role="group"
            aria-label="Cloudflare Turnstile"
            tabindex="-1"
          ></div>
          @if (verificationRetryAvailable()) {
            <div class="verification-recovery" role="alert">
              <p>安全驗證無法使用，請重新載入安全驗證。</p>
              <button
                type="button"
                class="verification-retry-action"
                [disabled]="busy()"
                (click)="retryVerification()"
              >
                重新載入安全驗證
              </button>
            </div>
          }
          @if (verificationRequired()) {
            <p class="field-error" role="alert">請先完成安全驗證。</p>
          }

          <button class="primary-action" type="submit" [disabled]="busy()">
            @if (state().kind === 'resolving') {
              正在取得影片……
            } @else {
              取得影片
            }
          </button>
          @if (statusMessage(); as message) {
            <p class="status-line" aria-live="polite" aria-atomic="true">
              {{ message }}
            </p>
          }
          @if (errorState(); as error) {
            @if (candidates().length === 0) {
              <div #workflowErrorPanel class="error-panel" role="alert" tabindex="-1">
                <p>{{ error.message }}</p>
                @if (error.requestId !== null) {
                  <p class="request-reference">參考編號：{{ error.requestId }}</p>
                }
                @if (canRetryBootstrap()) {
                  <button
                    type="button"
                    class="session-retry-action"
                    [disabled]="busy()"
                    (click)="retryBootstrap()"
                  >
                    重新建立安全工作階段
                  </button>
                }
              </div>
            }
          }
        </form>
      </section>

      @if (candidates().length > 0) {
        <section
          #candidateSection
          class="candidate-section"
          aria-labelledby="candidate-title"
          tabindex="-1"
        >
          <h2 id="candidate-title">找到 {{ candidates().length }} 個可下載版本</h2>
          @if (candidateStatusMessage(); as message) {
            <p class="candidate-status" aria-live="polite" aria-atomic="true">
              {{ message }}
            </p>
          }
          @if (errorState(); as error) {
            <div #workflowErrorPanel class="error-panel candidate-error" role="alert" tabindex="-1">
              <p>{{ error.message }}</p>
              @if (error.requestId !== null) {
                <p class="request-reference">參考編號：{{ error.requestId }}</p>
              }
            </div>
          }
          <ul class="candidate-list">
            @for (candidate of candidates(); track candidate.candidateId; let index = $index) {
              <li>
                <div class="candidate-card-topline">
                  @if (candidate.width !== undefined && candidate.height !== undefined) {
                    <dl>
                      <div>
                        <dt>畫質</dt>
                        <dd>{{ candidate.width }} × {{ candidate.height }}</dd>
                      </div>
                      @if (candidate.duration !== undefined) {
                        <div>
                          <dt>時長</dt>
                          <dd>{{ formatDuration(candidate.duration) }}</dd>
                        </div>
                      }
                      @if (candidate.contentLength !== undefined) {
                        <div>
                          <dt>大小</dt>
                          <dd>{{ formatBytes(candidate.contentLength) }}</dd>
                        </div>
                      }
                    </dl>
                  } @else if (
                    candidate.duration !== undefined || candidate.contentLength !== undefined
                  ) {
                    <dl>
                      @if (candidate.duration !== undefined) {
                        <div>
                          <dt>時長</dt>
                          <dd>{{ formatDuration(candidate.duration) }}</dd>
                        </div>
                      }
                      @if (candidate.contentLength !== undefined) {
                        <div>
                          <dt>大小</dt>
                          <dd>{{ formatBytes(candidate.contentLength) }}</dd>
                        </div>
                      }
                    </dl>
                  } @else {
                    <p class="candidate-fallback">影片資訊由來源決定</p>
                  }
                </div>
                <div class="candidate-handoff">
                  <h3>{{ candidate.filename }}</h3>
                  <button
                    type="button"
                    class="candidate-action"
                    [disabled]="busy()"
                    [attr.aria-label]="candidateActionLabel(candidate, index)"
                    (click)="download(candidate.candidateId)"
                  >
                    @if (isIssuingCandidate(candidate.candidateId)) {
                      正在準備下載……
                    } @else {
                      下載影片
                    }
                  </button>
                </div>
              </li>
            }
          </ul>
        </section>
      }
    </main>
  `,
})
export class DownloaderPageComponent implements OnDestroy {
  private readonly workflow = inject(DownloaderWorkflow);
  private readonly challenge = inject(TURNSTILE_CHALLENGE);
  private readonly turnstileContainer = viewChild<ElementRef<HTMLDivElement>>('turnstileContainer');
  private readonly postUrlInput = viewChild<ElementRef<HTMLInputElement>>('postUrlInput');
  private readonly rightsConfirmedInput =
    viewChild<ElementRef<HTMLInputElement>>('rightsConfirmedInput');
  private readonly challengeRegion = viewChild<ElementRef<HTMLDivElement>>('challengeRegion');
  private readonly workflowErrorPanel = viewChild<ElementRef<HTMLDivElement>>('workflowErrorPanel');
  private readonly candidateSection = viewChild<ElementRef<HTMLElement>>('candidateSection');
  private readonly widgetValue = signal<TurnstileWidgetHandle | null>(null);
  private readonly widgetMountFailed = signal(false);
  private readonly issuingCandidateId = signal<string | null>(null);
  private mountedSiteKey: string | null = null;
  private mountedContainer: HTMLDivElement | null = null;
  private focusedFeedbackState: DownloaderWorkflowState | null = null;
  private destroyed = false;
  private readonly synchronizeWidget = effect(() => {
    const container = this.turnstileContainer()?.nativeElement ?? null;
    const siteKey = siteKeyFrom(this.workflow.state());
    untracked(() => this.updateWidget(siteKey, container));
  });
  private readonly focusWorkflowFeedback = effect(() => {
    const state = this.workflow.state();
    let target: ElementRef<HTMLElement> | undefined;
    if (state.kind === 'candidates') {
      target = this.candidateSection();
    } else if (state.kind === 'error') {
      target = this.workflowErrorPanel();
    }
    if (target === undefined || this.focusedFeedbackState === state) {
      return;
    }
    untracked(() => {
      if (!this.destroyed) {
        target.nativeElement.focus();
        this.focusedFeedbackState = state;
      }
    });
  });

  readonly state = this.workflow.state;
  readonly form = new FormGroup({
    postUrl: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, threadsPostUrlValidator],
    }),
    rightsConfirmed: new FormControl(false, {
      nonNullable: true,
      validators: [Validators.requiredTrue],
    }),
  });
  readonly submittedWithoutVerification = signal(false);
  readonly candidates = computed(() => candidatesFrom(this.state()));
  readonly busy = computed(() => {
    const kind = this.state().kind;
    return kind === 'bootstrapping' || kind === 'resolving' || kind === 'issuing';
  });
  private readonly formLocked = computed(() => {
    const kind = this.state().kind;
    return kind === 'resolving' || kind === 'issuing';
  });
  private readonly synchronizeFormAvailability = effect(() => {
    const formLocked = this.formLocked();
    untracked(() => {
      if (formLocked) {
        this.form.disable({ emitEvent: false });
      } else {
        this.form.enable({ emitEvent: false });
      }
    });
  });
  readonly verified = computed(() => {
    const widget = this.widgetValue();
    return widget?.status() === 'verified' && widget.token() !== null;
  });
  readonly verificationRequired = computed(
    () => this.submittedWithoutVerification() && !this.verified(),
  );
  readonly verificationRetryAvailable = computed(() => {
    if (siteKeyFrom(this.state()) === null) {
      return false;
    }
    return this.widgetMountFailed() || this.widgetValue()?.status() === 'error';
  });
  readonly statusMessage = computed(() => statusText(this.state()));
  readonly candidateStatusMessage = computed(() => {
    const state = this.state();
    return state.kind === 'handed-off' ? state.message : null;
  });
  readonly errorState = computed(() => {
    const state = this.state();
    return state.kind === 'error' ? state : null;
  });
  readonly canRetryBootstrap = computed(() => {
    const state = this.state();
    return state.kind === 'error' && state.siteKey === null;
  });

  constructor() {
    void this.workflow.bootstrap();
  }

  async submit(): Promise<void> {
    this.form.markAllAsTouched();
    if (this.busy()) {
      return;
    }
    if (this.form.invalid) {
      const invalidInput = this.form.controls.postUrl.invalid
        ? this.postUrlInput()
        : this.rightsConfirmedInput();
      invalidInput?.nativeElement.focus();
      return;
    }
    if (!this.verified()) {
      this.submittedWithoutVerification.set(true);
      this.challengeRegion()?.nativeElement.focus();
      return;
    }
    this.submittedWithoutVerification.set(false);
    const value = this.form.getRawValue();
    await this.workflow.resolve(value.postUrl, value.rightsConfirmed);
  }

  async download(candidateId: string): Promise<void> {
    if (this.busy()) {
      return;
    }
    this.issuingCandidateId.set(candidateId);
    try {
      await this.workflow.download(candidateId);
    } finally {
      if (this.issuingCandidateId() === candidateId) {
        this.issuingCandidateId.set(null);
      }
    }
  }

  async retryBootstrap(): Promise<void> {
    if (!this.canRetryBootstrap() || this.busy()) {
      return;
    }
    await this.workflow.bootstrap();
  }

  retryVerification(): void {
    if (!this.verificationRetryAvailable() || this.busy()) {
      return;
    }
    const siteKey = siteKeyFrom(this.state());
    const container = this.turnstileContainer()?.nativeElement ?? null;
    this.submittedWithoutVerification.set(false);
    this.removeWidget();
    this.updateWidget(siteKey, container);
  }

  isIssuingCandidate(candidateId: string): boolean {
    return this.state().kind === 'issuing' && this.issuingCandidateId() === candidateId;
  }

  candidateActionLabel(candidate: ResolveCandidate, index: number): string {
    const action = this.isIssuingCandidate(candidate.candidateId) ? '正在準備下載' : '下載影片';
    return `${action}，版本 ${index + 1}：${candidate.filename}`;
  }

  formatDuration(duration: number): string {
    const totalSeconds = Math.max(0, Math.round(duration));
    const hours = Math.floor(totalSeconds / 3_600);
    const minutes = Math.floor((totalSeconds % 3_600) / 60);
    const seconds = totalSeconds % 60;
    const shortTime = `${minutes.toString().padStart(2, '0')}:${seconds
      .toString()
      .padStart(2, '0')}`;
    return hours === 0 ? shortTime : `${hours.toString().padStart(2, '0')}:${shortTime}`;
  }

  ngOnDestroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.removeWidget();
    this.workflow.destroy();
  }

  formatBytes(bytes: number): string {
    if (bytes < 1_024) {
      return `${bytes} B`;
    }
    if (bytes < 1_048_576) {
      return `${(bytes / 1_024).toFixed(1)} KB`;
    }
    return `${(bytes / 1_048_576).toFixed(1)} MB`;
  }

  private updateWidget(siteKey: string | null, container: HTMLDivElement | null): void {
    if (this.destroyed) {
      return;
    }
    if (
      siteKey !== null &&
      container !== null &&
      container.isConnected &&
      this.mountedSiteKey === siteKey &&
      this.mountedContainer === container
    ) {
      return;
    }
    this.removeWidget();
    if (siteKey === null || !container?.isConnected) {
      return;
    }
    let widget: TurnstileWidgetHandle;
    try {
      widget = this.challenge.mount({ siteKey, container });
    } catch {
      this.widgetMountFailed.set(true);
      return;
    }
    this.mountedSiteKey = siteKey;
    this.mountedContainer = container;
    this.widgetValue.set(widget);
    this.workflow.attachChallenge(widget);
  }

  private removeWidget(): void {
    const widget = this.widgetValue();
    this.widgetValue.set(null);
    this.widgetMountFailed.set(false);
    this.mountedSiteKey = null;
    this.mountedContainer = null;
    try {
      widget?.remove();
    } catch {
      return;
    }
  }
}

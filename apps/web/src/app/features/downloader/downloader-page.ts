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
import { RouterLink } from '@angular/router';
import { type ResolveCandidate } from '@threads-downloader/contracts';

import {
  TURNSTILE_CHALLENGE,
  type TurnstileWidgetHandle,
} from '../../core/turnstile/browser-turnstile-challenge.js';
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

function statusText(state: DownloaderWorkflowState): string {
  switch (state.kind) {
    case 'idle':
    case 'bootstrapping':
      return '正在建立安全工作階段。';
    case 'ready':
      return '工作階段已就緒。';
    case 'resolving':
      return '正在解析公開貼文。';
    case 'candidates':
      return `找到 ${state.candidates.length} 個可用候選。`;
    case 'issuing':
      return '正在建立瀏覽器下載工作。';
    case 'handed-off':
      return state.message;
    case 'error':
      return '操作未完成，請依錯誤訊息處理。';
  }
}

@Component({
  selector: 'app-downloader-page',
  imports: [ReactiveFormsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main id="main-content" class="downloader-page" aria-labelledby="page-title">
      <section class="hero" aria-labelledby="page-title">
        <p class="eyebrow">PUBLIC THREADS MEDIA / RESEARCH INTERFACE</p>
        <h1 id="page-title">Public media.<br />Direct handoff.</h1>
        <p class="hero-copy">
          輸入公開 Threads
          貼文網址，經安全驗證後取得可用影片候選，再由本站同源介面交給瀏覽器下載管理器。
        </p>
      </section>

      <section class="workbench" aria-labelledby="workbench-title">
        <div class="section-heading">
          <p aria-hidden="true">01</p>
          <h2 id="workbench-title">解析公開貼文</h2>
        </div>

        <form
          [formGroup]="form"
          [attr.aria-busy]="busy() ? 'true' : null"
          (ngSubmit)="submit()"
          novalidate
        >
          <div class="field">
            <label for="post-url">Threads 公開貼文網址</label>
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
            <p id="post-url-help" class="field-help">
              接受 threads.com、www.threads.com、threads.net 與 www.threads.net 的 HTTPS 貼文網址。
            </p>
            @if (form.controls.postUrl.invalid && form.controls.postUrl.touched) {
              <p id="post-url-error" class="field-error" role="alert">
                請輸入有效的公開 Threads 貼文網址。
              </p>
            }
          </div>

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
                  ? 'rights-help rights-error'
                  : 'rights-help'
              "
              required
            />
            <span id="rights-help"
              >我確認我擁有內容、已取得授權，或依適用法律得以保存；我了解學術或非商業目的本身不構成授權，並自行負責遵守法律與平台條款。</span
            >
          </label>
          @if (form.controls.rightsConfirmed.invalid && form.controls.rightsConfirmed.touched) {
            <p id="rights-error" class="field-error" role="alert">必須先確認內容使用權利。</p>
          }

          <div
            #challengeRegion
            class="challenge-block"
            aria-labelledby="challenge-title"
            tabindex="-1"
          >
            <div>
              <h3 id="challenge-title">安全驗證</h3>
              <p aria-live="polite" aria-atomic="true">{{ verificationMessage() }}</p>
              @if (verificationRetryAvailable()) {
                <button
                  type="button"
                  class="verification-retry-action"
                  [disabled]="busy()"
                  (click)="retryVerification()"
                >
                  重新載入安全驗證
                </button>
              }
            </div>
            <div #turnstileContainer class="turnstile-container"></div>
          </div>
          @if (verificationRequired()) {
            <p class="field-error" role="alert">請先完成安全驗證。</p>
          }

          <button class="primary-action" type="submit" [disabled]="busy()">
            @if (state().kind === 'resolving') {
              正在解析
            } @else {
              解析影片候選
            }
          </button>
        </form>
      </section>

      <section class="system-status" aria-labelledby="status-title">
        <div class="section-heading compact">
          <p aria-hidden="true">02</p>
          <h2 id="status-title">系統狀態</h2>
        </div>
        <p class="status-line" aria-live="polite" aria-atomic="true">{{ statusMessage() }}</p>
        @if (errorState(); as error) {
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
      </section>

      @if (candidates().length > 0) {
        <section
          #candidateSection
          class="candidate-section"
          aria-labelledby="candidate-title"
          tabindex="-1"
        >
          <div class="section-heading">
            <p aria-hidden="true">03</p>
            <h2 id="candidate-title">影片候選</h2>
          </div>
          <ul class="candidate-list">
            @for (candidate of candidates(); track candidate.candidateId; let index = $index) {
              <li>
                <div class="candidate-index" aria-hidden="true">
                  {{ (index + 1).toString().padStart(2, '0') }}
                </div>
                <div class="candidate-details">
                  <h3>{{ candidate.filename }}</h3>
                  <p>{{ candidateMetadata(candidate) }}</p>
                </div>
                <button
                  type="button"
                  class="candidate-action"
                  [disabled]="busy()"
                  [attr.aria-label]="candidateActionLabel(candidate, index)"
                  (click)="download(candidate.candidateId)"
                >
                  @if (isIssuingCandidate(candidate.candidateId)) {
                    正在建立下載
                  } @else {
                    交給瀏覽器下載
                  }
                </button>
              </li>
            }
          </ul>
        </section>
      }

      <section class="service-boundary" aria-labelledby="boundary-title">
        <div class="section-heading">
          <p aria-hidden="true">04</p>
          <h2 id="boundary-title">使用邊界</h2>
        </div>
        <div class="boundary-copy">
          <p>
            本服務之設置與營運目的僅為技術及學術研究，營運者不藉提供本服務獲取任何商業或經濟利益。
          </p>
          <p>
            上述目的與非商業聲明不代表營運者或使用者已取得任何內容授權，不表示特定下載、保存或其他使用必然合法或符合著作權限制或例外，也不免除任何人依適用法律應負的責任。
          </p>
          <p>
            公開可見、研究或非商業目的不等於授權；使用者必須擁有內容、取得有效授權，或依實際適用法律確實得為預定使用。
          </p>
          <p>
            本服務僅處理無需登入即可存取的公開內容，不繞過登入、存取控制、付費牆或其他技術限制。
          </p>
          <p>本服務並非 Meta、Instagram、Threads 或 SpaceX 的官方產品，亦未獲其背書或授權。</p>
          <nav class="boundary-links" aria-label="使用與權利資訊">
            <a routerLink="/terms">閱讀使用條款</a>
            <a routerLink="/privacy">閱讀隱私與資料處理說明</a>
            <a routerLink="/copyright">著作權與下架通知</a>
          </nav>
        </div>
      </section>
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
  private readonly synchronizeFormAvailability = effect(() => {
    const busy = this.busy();
    untracked(() => {
      if (busy) {
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
  readonly verificationMessage = computed(() => {
    if (this.widgetMountFailed()) {
      return '安全驗證無法使用，請重新載入安全驗證。';
    }
    const widget = this.widgetValue();
    if (widget === null) {
      return siteKeyFrom(this.state()) === null ? '等待安全工作階段。' : '正在載入安全驗證。';
    }
    switch (widget.status()) {
      case 'loading':
        return '正在載入安全驗證。';
      case 'ready':
        return '請完成安全驗證。';
      case 'verified':
        return '安全驗證已通過，可提交解析。';
      case 'error':
        return '安全驗證無法使用，請重新載入安全驗證。';
      case 'removed':
        return '安全驗證已停止。';
    }
  });
  readonly statusMessage = computed(() => statusText(this.state()));
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
    const action = this.isIssuingCandidate(candidate.candidateId)
      ? '正在建立下載'
      : '交給瀏覽器下載';
    return `${action}，候選 ${index + 1}：${candidate.filename}`;
  }

  candidateMetadata(candidate: ResolveCandidate): string {
    const metadata: string[] = [];
    if (candidate.width !== undefined && candidate.height !== undefined) {
      metadata.push(`${candidate.width} × ${candidate.height}`);
    }
    if (candidate.duration !== undefined) {
      metadata.push(`${candidate.duration.toFixed(1)} 秒`);
    }
    if (candidate.contentLength !== undefined) {
      metadata.push(this.formatBytes(candidate.contentLength));
    }
    return metadata.length === 0 ? '影片資訊由來源決定' : metadata.join(' / ');
  }

  ngOnDestroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.removeWidget();
    this.workflow.destroy();
  }

  private formatBytes(bytes: number): string {
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

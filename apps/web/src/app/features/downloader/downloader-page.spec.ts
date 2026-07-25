import { signal, type WritableSignal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormControl } from '@angular/forms';
import { type ResolveCandidate } from '@threads-downloader/contracts';
import type { Mock } from 'vitest';

import {
  TURNSTILE_CHALLENGE,
  type TurnstileWidgetHandle,
  type TurnstileWidgetStatus,
} from '../../core/turnstile/browser-turnstile-challenge.js';
import { DownloaderPageComponent, threadsPostUrlValidator } from './downloader-page.js';
import { DownloaderWorkflow, type DownloaderWorkflowState } from './downloader-workflow.js';

const SITE_KEY = '0x4AAAAAAD9Gx9nArUYJAkKJ';
const OTHER_SITE_KEY = '0x4AAAAAAD9Gx9nArUYJAkXX';
const CANDIDATE_ID = 'C'.repeat(32);
const REQUEST_ID = 'Q'.repeat(32);
const INSECURE_PROTOCOL = 'http:';
const candidate: ResolveCandidate = {
  candidateId: CANDIDATE_ID,
  filename: 'threads_Abcde_1.mp4',
  contentLength: 2_097_152,
  width: 1920,
  height: 1080,
  duration: 12.5,
};

interface WidgetFixture {
  readonly handle: TurnstileWidgetHandle;
  readonly status: WritableSignal<TurnstileWidgetStatus>;
  readonly token: WritableSignal<string | null>;
  readonly reset: Mock<() => void>;
  readonly remove: Mock<() => void>;
}

function widgetFixture(): WidgetFixture {
  const status = signal<TurnstileWidgetStatus>('ready');
  const token = signal<string | null>(null);
  const reset = vi.fn<() => void>(() => {
    token.set(null);
    status.set('ready');
  });
  const remove = vi.fn<() => void>(() => {
    token.set(null);
    status.set('removed');
  });
  return {
    handle: { status: status.asReadonly(), token: token.asReadonly(), reset, remove },
    status,
    token,
    reset,
    remove,
  };
}

describe('threadsPostUrlValidator', () => {
  it.each([
    'https://threads.com/@alice/post/Abcde',
    'https://www.threads.com/@alice_1/post/Abcde_1',
    'https://threads.net/@a.b/post/abcde-1/',
    'https://www.threads.net/@alice/post/Abcde?source=share',
  ])('accepts a supported public post URL: %s', (value) => {
    const control = new FormControl(value, { validators: [threadsPostUrlValidator] });

    expect(control.errors).toBeNull();
  });

  it.each([
    `${INSECURE_PROTOCOL}//threads.com/@alice/post/Abcde`,
    'https://example.com/@alice/post/Abcde',
    'https://threads.com/@alice/profile/Abcde',
    'https://threads.com/@alice/post/abcd',
    'https://threads.com/%40alice/post/Abcde',
    'https://threads.com/@alice/post/Abcde#fragment',
    'https://user@threads.com/@alice/post/Abcde',
  ])('rejects an unsupported or unsafe URL: %s', (value) => {
    const control = new FormControl(value, { validators: [threadsPostUrlValidator] });

    expect(control.errors).toEqual({ threadsPostUrl: true });
  });
});

describe('DownloaderPageComponent', () => {
  let fixture: ComponentFixture<DownloaderPageComponent>;
  let state: WritableSignal<DownloaderWorkflowState>;
  let bootstrap: Mock<() => Promise<void>>;
  let attachChallenge: Mock<(handle: TurnstileWidgetHandle) => void>;
  let resolve: Mock<(postUrl: string, rightsConfirmed: boolean) => Promise<void>>;
  let download: Mock<(candidateId: string) => Promise<void>>;
  let destroy: Mock<() => void>;
  let mount: Mock<
    (command: {
      readonly siteKey: string;
      readonly container: HTMLElement;
    }) => TurnstileWidgetHandle
  >;
  let widgets: WidgetFixture[];

  async function render(): Promise<void> {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  beforeEach(async () => {
    state = signal<DownloaderWorkflowState>({ kind: 'ready', siteKey: SITE_KEY });
    bootstrap = vi.fn<() => Promise<void>>(() => Promise.resolve());
    attachChallenge = vi.fn<(handle: TurnstileWidgetHandle) => void>();
    resolve = vi.fn<(postUrl: string, rightsConfirmed: boolean) => Promise<void>>(() =>
      Promise.resolve(),
    );
    download = vi.fn<(candidateId: string) => Promise<void>>(() => Promise.resolve());
    destroy = vi.fn<() => void>();
    widgets = [];
    mount = vi.fn(() => {
      const widget = widgetFixture();
      widgets.push(widget);
      return widget.handle;
    });

    await TestBed.configureTestingModule({
      imports: [DownloaderPageComponent],
      providers: [
        {
          provide: DownloaderWorkflow,
          useValue: {
            state: state.asReadonly(),
            bootstrap,
            attachChallenge,
            resolve,
            download,
            destroy,
          },
        },
        { provide: TURNSTILE_CHALLENGE, useValue: { mount } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(DownloaderPageComponent);
    await render();
  });

  it('bootstraps once and owns one widget across same-site-key state changes', async () => {
    expect(bootstrap).toHaveBeenCalledOnce();
    expect(mount).toHaveBeenCalledOnce();
    expect(mount.mock.calls[0]?.[0]).toMatchObject({ siteKey: SITE_KEY });
    expect(mount.mock.calls[0]?.[0].container.isConnected).toBe(true);
    expect(attachChallenge).toHaveBeenCalledWith(widgets[0]?.handle);
    const verificationMessage = (fixture.nativeElement as HTMLElement).querySelector(
      '.challenge-block [aria-live="polite"]',
    );
    expect(verificationMessage?.getAttribute('aria-atomic')).toBe('true');

    state.set({ kind: 'resolving', siteKey: SITE_KEY });
    await render();
    expect(mount).toHaveBeenCalledOnce();

    state.set({ kind: 'ready', siteKey: OTHER_SITE_KEY });
    await render();
    expect(widgets[0]?.remove).toHaveBeenCalledOnce();
    expect(mount).toHaveBeenCalledTimes(2);
    expect(mount.mock.calls[1]?.[0]).toMatchObject({ siteKey: OTHER_SITE_KEY });

    fixture.destroy();
    expect(widgets[1]?.remove).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('fails closed when mounting fails and still destroys after widget removal throws', async () => {
    widgets[0]?.remove.mockImplementationOnce(() => {
      throw new Error('fixture remove failure');
    });
    mount.mockImplementationOnce(() => {
      throw new Error('fixture mount failure');
    });

    state.set({ kind: 'ready', siteKey: OTHER_SITE_KEY });
    await render();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      '安全驗證無法使用，請重新載入頁面。',
    );
    expect(fixture.componentInstance.verified()).toBe(false);
    expect(() => fixture.destroy()).not.toThrow();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('requires a valid URL, explicit rights, and verification before resolve', async () => {
    const component = fixture.componentInstance;
    component.form.setValue({
      postUrl: 'https://example.com/not-supported',
      rightsConfirmed: false,
    });
    expect(
      (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.primary-action')
        ?.disabled,
    ).toBe(false);
    await component.submit();
    await render();

    expect(component.form.invalid).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
    const root = fixture.nativeElement as HTMLElement;
    const urlInput = root.querySelector<HTMLInputElement>('#post-url');
    const rightsInput = root.querySelector<HTMLInputElement>('#rights-confirmed');
    expect(urlInput?.getAttribute('aria-invalid')).toBe('true');
    expect(urlInput?.getAttribute('aria-describedby')).toBe('post-url-help post-url-error');
    expect(rightsInput?.getAttribute('aria-invalid')).toBe('true');
    expect(rightsInput?.getAttribute('aria-describedby')).toBe('rights-help rights-error');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      '學術或非商業目的本身不構成授權',
    );

    component.form.setValue({
      postUrl: ' https://www.threads.com/@alice/post/Abcde ',
      rightsConfirmed: true,
    });
    await render();
    expect(urlInput?.hasAttribute('aria-invalid')).toBe(false);
    expect(rightsInput?.hasAttribute('aria-invalid')).toBe(false);
    await component.submit();
    expect(resolve).not.toHaveBeenCalled();
    expect(component.verificationRequired()).toBe(true);

    widgets[0]?.token.set('verified-widget-response');
    widgets[0]?.status.set('verified');
    await component.submit();

    expect(resolve).toHaveBeenCalledWith(' https://www.threads.com/@alice/post/Abcde ', true);
  });

  it('renders safe candidate metadata and dispatches only its opaque candidate ID', async () => {
    state.set({ kind: 'candidates', siteKey: SITE_KEY, candidates: [candidate] });
    await render();
    const root = fixture.nativeElement as HTMLElement;
    const action = root.querySelector<HTMLButtonElement>('.candidate-action');

    expect(root.textContent).toContain('threads_Abcde_1.mp4');
    expect(root.textContent).toContain('1920 × 1080 / 12.5 秒 / 2.0 MB');
    expect(root.textContent).not.toContain(CANDIDATE_ID);
    action?.click();
    await fixture.whenStable();

    expect(download).toHaveBeenCalledWith(CANDIDATE_ID);
  });

  it('disables mutation controls while the workflow is issuing', async () => {
    state.set({ kind: 'issuing', siteKey: SITE_KEY, candidates: [candidate] });
    widgets[0]?.token.set('verified-widget-response');
    widgets[0]?.status.set('verified');
    fixture.componentInstance.form.setValue({
      postUrl: 'https://threads.com/@alice/post/Abcde',
      rightsConfirmed: true,
    });
    await render();
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector<HTMLButtonElement>('.primary-action')?.disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('.candidate-action')?.disabled).toBe(true);
  });

  it('announces only the fixed handoff message and safe API error projection', async () => {
    state.set({
      kind: 'handed-off',
      siteKey: SITE_KEY,
      candidates: [candidate],
      message: '已交由瀏覽器下載管理器處理。',
    });
    await render();
    let root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('.status-line')?.textContent?.trim()).toBe(
      '已交由瀏覽器下載管理器處理。',
    );
    expect(root.textContent).not.toContain('檔案已成功儲存');

    state.set({
      kind: 'error',
      siteKey: SITE_KEY,
      code: 'RATE_LIMITED',
      message: '操作過於頻繁，請稍後再試。',
      requestId: REQUEST_ID,
      candidates: [candidate],
    });
    await render();
    root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      '操作過於頻繁，請稍後再試。',
    );
    expect(root.textContent).toContain(`參考編號：${REQUEST_ID}`);
  });

  it('states the research purpose and adjacent service boundaries without affiliation claims', () => {
    const paragraphs = [
      ...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLParagraphElement>(
        '.boundary-copy p',
      ),
    ].map((paragraph) => paragraph.textContent?.trim());

    expect(paragraphs).toEqual([
      '本服務之設置與營運目的僅為技術及學術研究，營運者不藉提供本服務獲取任何商業或經濟利益。',
      '上述目的與非商業聲明不代表營運者或使用者已取得任何內容授權，不表示特定下載、保存或其他使用必然合法或符合著作權限制或例外，也不免除任何人依適用法律應負的責任。',
      '本服務僅處理無需登入即可存取的公開內容，不繞過登入、存取控制、付費牆或其他技術限制。',
      '本服務並非 Meta、Instagram、Threads 或 SpaceX 的官方產品，亦未獲其背書或授權。',
    ]);
  });
});

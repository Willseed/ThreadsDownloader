import { signal, type WritableSignal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormControl } from '@angular/forms';
import { provideRouter } from '@angular/router';
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
const otherCandidate: ResolveCandidate = {
  candidateId: 'D'.repeat(32),
  filename: 'threads_Abcde_2.mp4',
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
        provideRouter([]),
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(DownloaderPageComponent);
    await render();
  });

  it('renders one concise download flow without a separate system-status section', () => {
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('#page-title')?.textContent?.trim()).toBe('下載公開 Threads 影片');
    expect(root.querySelector('.hero-copy')?.textContent?.trim()).toBe(
      '貼上貼文網址，驗證後選擇影片版本。',
    );
    expect(root.querySelector('.system-status')).toBeNull();
    expect(root.querySelector<HTMLButtonElement>('.primary-action')?.textContent?.trim()).toBe(
      '取得影片',
    );
    expect(root.querySelector('.status-line')).toBeNull();
    expect(root.querySelector('.error-panel')).toBeNull();
    expect(root.textContent).not.toContain('僅支援免登入公開貼文');
    expect(root.textContent).not.toContain('PUBLIC THREADS MEDIA / RESEARCH INTERFACE');
    expect(root.textContent).not.toContain('Public media.');
    expect(root.textContent).not.toContain('Direct handoff.');
  });

  it('bootstraps once and owns one widget across same-site-key state changes', async () => {
    expect(bootstrap).toHaveBeenCalledOnce();
    expect(mount).toHaveBeenCalledOnce();
    expect(mount.mock.calls[0]?.[0]).toMatchObject({ siteKey: SITE_KEY });
    expect(mount.mock.calls[0]?.[0].container.isConnected).toBe(true);
    expect(attachChallenge).toHaveBeenCalledWith(widgets[0]?.handle);
    expect((fixture.nativeElement as HTMLElement).querySelector('.status-line')).toBeNull();
    const root = fixture.nativeElement as HTMLElement;
    const container = root.querySelector('.turnstile-container');
    expect(container?.getAttribute('role')).toBe('group');
    expect(container?.getAttribute('aria-label')).toBe('Cloudflare Turnstile');
    expect(container?.getAttribute('tabindex')).toBe('-1');
    expect(root.querySelector('.challenge-block')).toBeNull();
    expect(root.querySelector('#challenge-title')).toBeNull();
    expect(root.textContent).not.toContain('安全驗證');

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

  it('removes the widget without remounting into a disconnected container', async () => {
    const container = (fixture.nativeElement as HTMLElement).querySelector('.turnstile-container');
    expect(container).not.toBeNull();
    container?.remove();

    state.set({ kind: 'ready', siteKey: OTHER_SITE_KEY });
    await render();

    expect(widgets[0]?.remove).toHaveBeenCalledOnce();
    expect(mount).toHaveBeenCalledOnce();
    expect(attachChallenge).toHaveBeenCalledOnce();
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
      '安全驗證無法使用，請重新載入安全驗證。',
    );
    expect(fixture.componentInstance.verified()).toBe(false);
    const retry = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      '.verification-retry-action',
    );
    expect(retry?.textContent?.trim()).toBe('重新載入安全驗證');
    retry?.click();
    await render();

    expect(mount).toHaveBeenCalledTimes(3);
    expect(mount.mock.calls[2]?.[0]).toMatchObject({ siteKey: OTHER_SITE_KEY });
    expect(attachChallenge).toHaveBeenLastCalledWith(widgets[1]?.handle);
    expect(() => fixture.destroy()).not.toThrow();
    expect(widgets[1]?.remove).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('removes and remounts a widget that reports an error', async () => {
    widgets[0]?.status.set('error');
    await render();

    const retry = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      '.verification-retry-action',
    );
    expect(retry).not.toBeNull();
    retry?.click();
    await render();

    expect(widgets[0]?.remove).toHaveBeenCalledOnce();
    expect(mount).toHaveBeenCalledTimes(2);
    expect(mount.mock.calls[1]?.[0]).toMatchObject({ siteKey: SITE_KEY });
    expect(attachChallenge).toHaveBeenLastCalledWith(widgets[1]?.handle);
  });

  it('retries a failed bootstrap without clearing the form', async () => {
    fixture.componentInstance.form.setValue({
      postUrl: 'https://threads.com/@alice/post/Abcde',
      rightsConfirmed: true,
    });
    state.set({
      kind: 'error',
      siteKey: null,
      code: 'CLIENT_UNAVAILABLE',
      message: '服務暫時無法使用，請稍後再試。',
      requestId: null,
    });
    await render();

    const retry = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      '.session-retry-action',
    );
    expect(retry?.textContent?.trim()).toBe('重新建立安全工作階段');
    retry?.click();
    await fixture.whenStable();

    expect(bootstrap).toHaveBeenCalledTimes(2);
    expect(fixture.componentInstance.form.getRawValue()).toEqual({
      postUrl: 'https://threads.com/@alice/post/Abcde',
      rightsConfirmed: true,
    });
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
    expect(rightsInput?.getAttribute('aria-describedby')).toBe('rights-detail rights-error');
    expect(root.ownerDocument.activeElement).toBe(urlInput);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      '學術或非商業目的本身不構成授權',
    );

    component.form.setValue({
      postUrl: 'https://www.threads.com/@alice/post/Abcde',
      rightsConfirmed: false,
    });
    await component.submit();
    expect(root.ownerDocument.activeElement).toBe(rightsInput);

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
    expect(root.ownerDocument.activeElement).toBe(root.querySelector('.turnstile-container'));

    widgets[0]?.token.set('verified-widget-response');
    widgets[0]?.status.set('verified');
    await render();
    expect(root.textContent).not.toContain('請完成安全驗證');
    await component.submit();

    expect(resolve).toHaveBeenCalledWith(' https://www.threads.com/@alice/post/Abcde ', true);
  });

  it('renders safe candidate metadata and dispatches only its opaque candidate ID', async () => {
    state.set({
      kind: 'candidates',
      siteKey: SITE_KEY,
      candidates: [candidate, otherCandidate],
    });
    await render();
    const root = fixture.nativeElement as HTMLElement;
    const actions = [...root.querySelectorAll<HTMLButtonElement>('.candidate-action')];

    expect(root.textContent).toContain('threads_Abcde_1.mp4');
    expect(
      [...root.querySelectorAll('.candidate-card-topline dd')].map((item) =>
        item.textContent?.trim(),
      ),
    ).toEqual(['1920 × 1080', '00:13', '2.0 MB']);
    expect(root.textContent).not.toContain(CANDIDATE_ID);
    expect(actions.map((action) => action.getAttribute('aria-label'))).toEqual([
      '開啟或下載影片，版本 1：threads_Abcde_1.mp4',
      '開啟或下載影片，版本 2：threads_Abcde_2.mp4',
    ]);
    expect(new Set(actions.map((action) => action.getAttribute('aria-label'))).size).toBe(2);
    expect(root.ownerDocument.activeElement).toBe(root.querySelector('.candidate-section'));
    actions[0]?.click();
    await fixture.whenStable();

    expect(download).toHaveBeenCalledWith(CANDIDATE_ID);
  });

  it('shows progress on the candidate whose download is being issued', async () => {
    let finishDownload: (() => void) | undefined;
    const pendingDownload = new Promise<void>((resolvePending) => {
      finishDownload = resolvePending;
    });
    download.mockImplementationOnce(async () => {
      state.set({ kind: 'issuing', siteKey: SITE_KEY, candidates: [candidate, otherCandidate] });
      await pendingDownload;
      state.set({
        kind: 'handed-off',
        siteKey: SITE_KEY,
        candidates: [candidate, otherCandidate],
        message: '已交由瀏覽器處理；若開啟播放器，請使用瀏覽器的儲存功能。',
      });
    });
    state.set({
      kind: 'candidates',
      siteKey: SITE_KEY,
      candidates: [candidate, otherCandidate],
    });
    await render();

    const operation = fixture.componentInstance.download(CANDIDATE_ID);
    await render();
    const actions = [
      ...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>(
        '.candidate-action',
      ),
    ];

    expect(actions[0]?.disabled).toBe(true);
    expect(actions[0]?.textContent?.trim()).toBe('正在準備影片……');
    expect(actions[0]?.getAttribute('aria-label')).toBe(
      '正在準備影片，版本 1：threads_Abcde_1.mp4',
    );
    expect(actions[1]?.textContent?.trim()).toBe('開啟或下載影片');

    finishDownload?.();
    await operation;
  });

  it('keeps form fields editable while establishing a session and locks them for operations', async () => {
    fixture.componentInstance.form.setValue({
      postUrl: 'https://threads.com/@alice/post/Abcde',
      rightsConfirmed: true,
    });
    const root = fixture.nativeElement as HTMLElement;
    state.set({ kind: 'bootstrapping' });
    await render();

    expect(root.querySelector('form')?.getAttribute('aria-busy')).toBe('true');
    expect(root.querySelector<HTMLInputElement>('#post-url')?.disabled).toBe(false);
    expect(root.querySelector<HTMLInputElement>('#rights-confirmed')?.disabled).toBe(false);
    expect(root.querySelector<HTMLButtonElement>('.primary-action')?.disabled).toBe(true);
    expect(root.querySelector('.status-line')?.textContent?.trim()).toBe('正在建立安全工作階段……');

    const operationStates: readonly DownloaderWorkflowState[] = [
      { kind: 'resolving', siteKey: SITE_KEY },
      { kind: 'issuing', siteKey: SITE_KEY, candidates: [candidate] },
    ];

    for (const busyState of operationStates) {
      state.set(busyState);
      await render();

      expect(root.querySelector('form')?.getAttribute('aria-busy')).toBe('true');
      expect(root.querySelector<HTMLInputElement>('#post-url')?.disabled).toBe(true);
      expect(root.querySelector<HTMLInputElement>('#rights-confirmed')?.disabled).toBe(true);
      expect(root.querySelector<HTMLButtonElement>('.primary-action')?.disabled).toBe(true);
    }

    expect(root.querySelector<HTMLButtonElement>('.candidate-action')?.disabled).toBe(true);
  });

  it('announces only the fixed handoff message and safe API error projection', async () => {
    state.set({
      kind: 'handed-off',
      siteKey: SITE_KEY,
      candidates: [candidate],
      message: '已交由瀏覽器處理；若開啟播放器，請使用瀏覽器的儲存功能。',
    });
    await render();
    let root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('.status-line')).toBeNull();
    expect(root.querySelector('.candidate-status')?.textContent?.trim()).toBe(
      '已交由瀏覽器處理；若開啟播放器，請使用瀏覽器的儲存功能。',
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
    expect(root.querySelector('.candidate-section .error-panel')).not.toBeNull();
    expect(root.ownerDocument.activeElement).toBe(root.querySelector('.error-panel'));
  });

  it('keeps full legal documents on demand behind the concise rights summary', () => {
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('.service-boundary')).toBeNull();
    expect(root.textContent).not.toContain('使用邊界');
    expect(root.textContent).not.toContain('法務與資料處理全文採需要時載入');
    expect(root.textContent).not.toContain(
      '本服務之設置與營運目的僅為技術及學術研究，營運者不藉提供本服務獲取任何商業或經濟利益。',
    );
    expect(root.textContent).not.toContain('__Host-td_session');
    expect(root.querySelectorAll('a[href="/terms"]')).toHaveLength(1);
    expect(root.querySelector<HTMLAnchorElement>('a[href="/terms"]')?.textContent?.trim()).toBe(
      '查看內容使用責任',
    );
    expect(root.querySelectorAll('a[href="/privacy"], a[href="/copyright"]')).toHaveLength(0);
  });
});

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router, withDisabledInitialNavigation } from '@angular/router';

import { AppComponent } from './app.js';
import { appRoutes } from './app.routes.js';

const REQUEST_ID = 'Q'.repeat(32);

describe('AppComponent routing', () => {
  let fixture: ComponentFixture<AppComponent>;
  let http: HttpTestingController;
  let router: Router;

  function failPendingSessionRequests(): number {
    const requests = http.match('/api/session');
    for (const request of requests) {
      request.flush(
        {
          error: {
            code: 'SESSION_UNAVAILABLE',
            message: '工作階段暫時無法使用。',
            requestId: REQUEST_ID,
          },
        },
        { status: 503, statusText: 'Service Unavailable' },
      );
    }
    return requests.length;
  }

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter(appRoutes, withDisabledInitialNavigation()),
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
    fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
  });

  afterEach(() => {
    http.verify();
  });

  it('renders the rooted downloader landmark and redirects unknown paths to it', async () => {
    await router.navigateByUrl('/');
    fixture.detectChanges();
    expect(failPendingSessionRequests()).toBe(1);
    await fixture.whenStable();
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    const skipLinks = root.querySelectorAll<HTMLAnchorElement>('a.skip-link');
    const mainTargets = root.querySelectorAll<HTMLElement>('#main-content');
    expect(skipLinks).toHaveLength(1);
    expect(skipLinks[0]?.getAttribute('href')).toBe('#main-content');
    expect(mainTargets).toHaveLength(1);
    expect(mainTargets[0]?.tagName).toBe('MAIN');
    expect(document.querySelector('script[src*="challenges.cloudflare.com"]')).toBeNull();
    expect(root.querySelector('.site-nav a')?.textContent?.trim()).toBe('開始下載');
    expect(root.querySelector('.site-footer > p')?.textContent).toContain(
      '本服務非 Threads 官方服務',
    );
    expect(root.querySelector('.site-footer > p')?.textContent).not.toContain('僅支援免登入');

    await router.navigateByUrl('/unknown-path');
    fixture.detectChanges();
    failPendingSessionRequests();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(router.url).toBe('/');
    expect(root.querySelectorAll('#main-content')).toHaveLength(1);
  });

  it('switches all reactive copy and metadata between supported locales', async () => {
    await router.navigateByUrl('/');
    fixture.detectChanges();
    expect(failPendingSessionRequests()).toBe(1);
    await fixture.whenStable();
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    const select = root.querySelector<HTMLSelectElement>('#language-select');
    expect([...select!.options].map((option) => [option.value, option.text])).toEqual([
      ['zh-TW', '繁體中文'],
      ['zh-CN', '简体中文'],
      ['en', 'English'],
      ['es', 'Español'],
      ['ko', '한국어'],
      ['ja', '日本語'],
    ]);

    select!.value = 'zh-CN';
    select!.dispatchEvent(new Event('change'));
    TestBed.flushEffects();
    fixture.detectChanges();

    expect(document.documentElement.lang).toBe('zh-CN');
    expect(document.title).toBe('Threads Downloader — 公开媒体研究工具');
    expect(root.querySelector('.site-nav a')?.textContent?.trim()).toBe('开始下载');
    expect(root.querySelector('#page-title')?.textContent?.trim()).toBe('下载公开 Threads 视频');
    expect(select?.getAttribute('aria-label')).toBe('选择语言');

    select!.value = 'en';
    select!.dispatchEvent(new Event('change'));
    TestBed.flushEffects();
    fixture.detectChanges();

    expect(document.documentElement.lang).toBe('en');
    expect(document.title).toBe('Threads Downloader — Public Media Research Utility');
    expect(root.querySelector('.site-nav a')?.textContent?.trim()).toBe('Start download');
    expect(root.querySelector('#page-title')?.textContent?.trim()).toBe(
      'Download public Threads videos',
    );
    expect(select?.getAttribute('aria-label')).toBe('Select language');

    select!.value = 'es';
    select!.dispatchEvent(new Event('change'));
    TestBed.flushEffects();
    fixture.detectChanges();

    expect(document.documentElement.lang).toBe('es');
    expect(document.title).toBe(
      'Threads Downloader — Herramienta de investigación de contenido multimedia público',
    );
    expect(root.querySelector('.site-nav a')?.textContent?.trim()).toBe('Iniciar descarga');
    expect(root.querySelector('#page-title')?.textContent?.trim()).toBe(
      'Descargar videos públicos de Threads',
    );
    expect(select?.getAttribute('aria-label')).toBe('Seleccionar idioma');

    select!.value = 'ko';
    select!.dispatchEvent(new Event('change'));
    TestBed.flushEffects();
    fixture.detectChanges();

    expect(document.documentElement.lang).toBe('ko');
    expect(document.title).toBe('Threads Downloader — 공개 콘텐츠 연구 도구');
    expect(root.querySelector('.site-nav a')?.textContent?.trim()).toBe('다운로드 시작');
    expect(root.querySelector('#page-title')?.textContent?.trim()).toBe(
      '공개 Threads 동영상 다운로드',
    );
    expect(select?.getAttribute('aria-label')).toBe('언어 선택');

    select!.value = 'ja';
    select!.dispatchEvent(new Event('change'));
    TestBed.flushEffects();
    fixture.detectChanges();

    expect(document.documentElement.lang).toBe('ja');
    expect(document.title).toBe('Threads Downloader — 公開コンテンツ研究ツール');
    expect(root.querySelector('.site-nav a')?.textContent?.trim()).toBe('ダウンロードを開始');
    expect(root.querySelector('#page-title')?.textContent?.trim()).toBe(
      '公開Threads動画をダウンロード',
    );
    expect(select?.getAttribute('aria-label')).toBe('言語を選択');
  });

  it.each([
    ['/terms', '使用條款'],
    ['/privacy', '隱私與資料處理說明'],
    ['/copyright', '著作權與下架通知'],
  ])('routes %s to one labelled legal main landmark', async (path, heading) => {
    await router.navigateByUrl(path);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    const main = root.querySelector<HTMLElement>('main#main-content');
    const headerLinks = [...root.querySelectorAll<HTMLAnchorElement>('.site-nav a')].map((link) =>
      link.getAttribute('href'),
    );
    const footerLinks = [
      ...root.querySelectorAll<HTMLAnchorElement>('.site-footer nav[aria-label="法務資訊"] a'),
    ].map((link) => link.getAttribute('href'));

    expect(router.url).toBe(path);
    expect(root.querySelectorAll('#main-content')).toHaveLength(1);
    expect(main?.getAttribute('aria-labelledby')).toBe('page-title');
    expect(main?.querySelector('#page-title')?.textContent?.trim()).toBe(heading);
    expect(headerLinks).toEqual(['/#download-workflow']);
    expect(footerLinks).toEqual(['/terms', '/privacy', '/copyright']);
  });

  it('loads legal copy only after a modal trigger and restores focus on Escape', async () => {
    await router.navigateByUrl('/');
    fixture.detectChanges();
    expect(failPendingSessionRequests()).toBe(1);
    await fixture.whenStable();
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    const trigger = root.querySelector<HTMLAnchorElement>('.site-footer a[href="/privacy"]');
    expect(root.textContent).not.toContain('__Host-td_session');
    expect(root.querySelector('.legal-modal[open]')).toBeNull();

    trigger?.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const dialog = root.querySelector<HTMLDialogElement>('.legal-modal');
    expect(router.url).toBe('/');
    expect(dialog?.hasAttribute('open')).toBe(true);
    expect(dialog?.getAttribute('aria-labelledby')).toBe('legal-modal-privacy-title');
    expect(dialog?.querySelector('#legal-modal-privacy-title')?.textContent?.trim()).toBe(
      '隱私與資料處理說明',
    );
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(dialog?.textContent).toContain('__Host-td_session');
    });
    expect(root.querySelectorAll('#main-content')).toHaveLength(1);
    expect(root.ownerDocument.activeElement).toBe(
      dialog?.querySelector<HTMLButtonElement>('.legal-modal-close'),
    );

    dialog?.dispatchEvent(new Event('cancel', { cancelable: true }));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(dialog?.hasAttribute('open')).toBe(false);
    expect(dialog?.textContent).not.toContain('__Host-td_session');
    expect(root.ownerDocument.activeElement).toBe(trigger);
  });
});

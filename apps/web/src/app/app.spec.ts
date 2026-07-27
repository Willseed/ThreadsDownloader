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

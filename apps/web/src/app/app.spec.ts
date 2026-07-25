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

    await router.navigateByUrl('/unknown-path');
    fixture.detectChanges();
    failPendingSessionRequests();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(router.url).toBe('/');
    expect(root.querySelectorAll('#main-content')).toHaveLength(1);
  });
});

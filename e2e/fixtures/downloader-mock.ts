import { expect, test as base, type CDPSession, type Page, type Route } from '@playwright/test';

const APP_ORIGIN = 'http://127.0.0.1:4200';
const TURNSTILE_SCRIPT_URL =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

export const THREADS_POST_URL = 'https://www.threads.com/@researcher/post/Abcde_123';
export const SESSION_CSRF_TOKEN = 'A'.repeat(43);
export const TURNSTILE_TOKEN = 'turnstile-test-token';
export const RESOLVE_ID = 'R'.repeat(32);
export const CANDIDATE_ID = 'C'.repeat(32);
export const DOWNLOAD_ID = 'D'.repeat(32);
export const MOCK_CDN_HOSTNAME = 'video.cdn.invalid';
export const SAFE_API_ERROR_MESSAGE = '暫時無法解析這則公開貼文，請稍後再試。';
export const SAFE_REQUEST_ID = 'Q'.repeat(32);

export const PRIVATE_DOM_VALUES = Object.freeze([
  SESSION_CSRF_TOKEN,
  TURNSTILE_TOKEN,
  RESOLVE_ID,
  DOWNLOAD_ID,
  MOCK_CDN_HOSTNAME,
]);

const SESSION_RESPONSE = Object.freeze({
  csrfToken: SESSION_CSRF_TOKEN,
  expiresAt: '2030-01-01T00:00:00.000Z',
  turnstileSiteKey: 'test-site-key',
});

const RESOLVE_RESPONSE = Object.freeze({
  resolveId: RESOLVE_ID,
  expiresAt: '2030-01-01T00:05:00.000Z',
  candidates: Object.freeze([
    Object.freeze({
      candidateId: CANDIDATE_ID,
      filename: 'research-video-01.mp4',
      contentLength: 1_048_576,
      width: 1080,
      height: 1920,
      duration: 12.5,
    }),
  ]),
});

const DOWNLOAD_SESSION_RESPONSE = Object.freeze({
  downloadId: DOWNLOAD_ID,
  downloadUrl: `/api/download/${DOWNLOAD_ID}`,
  startExpiresAt: '2030-01-01T00:02:00.000Z',
});

const DOWNLOAD_BODY_BASE64 = Buffer.from('mock-media').toString('base64');

const TURNSTILE_STUB = `
(() => {
  const token = ${JSON.stringify(TURNSTILE_TOKEN)};
  let activeContainer = null;
  let activeOptions = null;
  const api = Object.freeze({
    ready(callback) {
      queueMicrotask(callback);
    },
    render(container, options) {
      activeContainer = container;
      activeOptions = options;
      const indicator = document.createElement('div');
      indicator.setAttribute('role', 'status');
      indicator.setAttribute('aria-label', '安全驗證測試替身');
      indicator.textContent = '安全驗證已完成';
      indicator.style.inlineSize = '150px';
      indicator.style.minBlockSize = '65px';
      container.replaceChildren(indicator);
      queueMicrotask(() => options.callback(token));
      return 'mock-turnstile-widget';
    },
    reset() {
      if (activeOptions !== null) {
        queueMicrotask(() => activeOptions.callback(token));
      }
    },
    remove() {
      if (activeContainer !== null) {
        activeContainer.replaceChildren();
      }
      activeContainer = null;
      activeOptions = null;
    },
  });
  Object.defineProperty(window, 'turnstile', {
    configurable: true,
    value: api,
  });
})();
`;

interface MockApiCalls {
  session: number;
  resolve: number;
  downloadSessions: number;
  downloads: number;
}

interface TestFixtures {
  readonly mockApi: MockDownloaderApi;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function validResolveRequest(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['csrfToken', 'postUrl', 'rightsConfirmed', 'turnstileToken']) &&
    value['postUrl'] === THREADS_POST_URL &&
    value['csrfToken'] === SESSION_CSRF_TOKEN &&
    value['turnstileToken'] === TURNSTILE_TOKEN &&
    value['rightsConfirmed'] === true
  );
}

function validDownloadSessionRequest(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['candidateId', 'csrfToken', 'resolveId']) &&
    value['resolveId'] === RESOLVE_ID &&
    value['candidateId'] === CANDIDATE_ID &&
    value['csrfToken'] === SESSION_CSRF_TOKEN
  );
}

async function fulfillJson(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    headers: { 'cache-control': 'no-store' },
    body: JSON.stringify(body),
  });
}

function requestBody(route: Route): unknown {
  try {
    return route.request().postDataJSON() as unknown;
  } catch {
    return null;
  }
}

export class MockDownloaderApi {
  readonly calls: MockApiCalls = {
    session: 0,
    resolve: 0,
    downloadSessions: 0,
    downloads: 0,
  };

  resolveDelayMs = 0;
  private resolveShouldFail = false;
  private readonly unexpectedApiRequests: string[] = [];
  private readonly blockedExternalRequests: string[] = [];
  private readonly pageErrors: string[] = [];

  async install(page: Page): Promise<void> {
    page.on('pageerror', (error) => this.pageErrors.push(error.message));

    await page.route('**/*', (route) => this.guardExternalRequest(route));
    await page.route(`${APP_ORIGIN}/api/**`, (route) => this.rejectUnexpectedApi(route));
    await page.route(TURNSTILE_SCRIPT_URL, (route) => this.fulfillTurnstile(route));
    await page.route(`${APP_ORIGIN}/api/session`, (route) => this.fulfillSession(route));
    await page.route(`${APP_ORIGIN}/api/resolve`, (route) => this.fulfillResolve(route));
    await page.route(`${APP_ORIGIN}/api/download-sessions`, (route) =>
      this.fulfillDownloadSession(route),
    );
    await page.route(`${APP_ORIGIN}/api/download/${DOWNLOAD_ID}`, (route) =>
      this.fulfillDownload(route),
    );
    // Chromium hands an <a download> navigation directly to its download manager, outside page routes.
    // Keep the page.route contract above and fulfill that browser-owned hop with a page-scoped CDP session.
    await this.installBrowserDownloadFallback(page);
  }

  failResolveWithSafeError(): void {
    this.resolveShouldFail = true;
  }

  verify(): void {
    expect(this.unexpectedApiRequests, 'unexpected same-origin API requests').toEqual([]);
    expect(this.blockedExternalRequests, 'unexpected external network requests').toEqual([]);
    expect(this.pageErrors, 'uncaught browser page errors').toEqual([]);
  }

  private async guardExternalRequest(route: Route): Promise<void> {
    const url = new URL(route.request().url());
    if (url.origin === APP_ORIGIN) {
      await route.fallback();
      return;
    }
    this.blockedExternalRequests.push(`${route.request().method()} ${url.origin}${url.pathname}`);
    await route.abort('blockedbyclient');
  }

  private async rejectUnexpectedApi(route: Route): Promise<void> {
    const request = route.request();
    this.unexpectedApiRequests.push(`${request.method()} ${new URL(request.url()).pathname}`);
    await fulfillJson(route, 404, { ok: false });
  }

  private async fulfillTurnstile(route: Route): Promise<void> {
    if (route.request().method() !== 'GET') {
      this.unexpectedApiRequests.push('non-GET Turnstile script request');
      await route.abort('blockedbyclient');
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript; charset=utf-8',
      headers: { 'cache-control': 'no-store' },
      body: TURNSTILE_STUB,
    });
  }

  private async fulfillSession(route: Route): Promise<void> {
    if (route.request().method() !== 'GET') {
      this.unexpectedApiRequests.push('non-GET session request');
      await fulfillJson(route, 405, { ok: false });
      return;
    }
    this.calls.session += 1;
    await fulfillJson(route, 200, SESSION_RESPONSE);
  }

  private async fulfillResolve(route: Route): Promise<void> {
    if (route.request().method() !== 'POST' || !validResolveRequest(requestBody(route))) {
      this.unexpectedApiRequests.push('invalid resolve request');
      await fulfillJson(route, 400, { ok: false });
      return;
    }
    this.calls.resolve += 1;
    if (this.resolveDelayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.resolveDelayMs));
    }
    if (this.resolveShouldFail) {
      await fulfillJson(route, 503, {
        error: {
          code: 'RESOLVE_UNAVAILABLE',
          message: SAFE_API_ERROR_MESSAGE,
          requestId: SAFE_REQUEST_ID,
        },
      });
      return;
    }
    await fulfillJson(route, 200, RESOLVE_RESPONSE);
  }

  private async fulfillDownloadSession(route: Route): Promise<void> {
    if (route.request().method() !== 'POST' || !validDownloadSessionRequest(requestBody(route))) {
      this.unexpectedApiRequests.push('invalid download-session request');
      await fulfillJson(route, 400, { ok: false });
      return;
    }
    this.calls.downloadSessions += 1;
    await fulfillJson(route, 201, DOWNLOAD_SESSION_RESPONSE);
  }

  private async fulfillDownload(route: Route): Promise<void> {
    if (route.request().method() !== 'GET') {
      this.unexpectedApiRequests.push('non-GET download request');
      await route.abort('blockedbyclient');
      return;
    }
    this.calls.downloads += 1;
    await route.fulfill({
      status: 200,
      contentType: 'video/mp4',
      headers: {
        'cache-control': 'no-store',
        'content-disposition': 'attachment; filename="research-video-01.mp4"',
      },
      body: 'mock-media',
    });
  }

  private async installBrowserDownloadFallback(page: Page): Promise<void> {
    const session = await page.context().newCDPSession(page);
    await session.send('Fetch.enable', {
      patterns: [
        {
          requestStage: 'Request',
          urlPattern: `${APP_ORIGIN}/api/download/*`,
        },
      ],
    });
    session.on('Fetch.requestPaused', (event) => {
      void this.fulfillBrowserDownload(
        session,
        event.requestId,
        event.request.url,
        event.request.method,
      ).catch(() => this.pageErrors.push('browser download mock failed'));
    });
  }

  private async fulfillBrowserDownload(
    session: CDPSession,
    requestId: string,
    url: string,
    method: string,
  ): Promise<void> {
    if (url !== `${APP_ORIGIN}/api/download/${DOWNLOAD_ID}` || method !== 'GET') {
      this.unexpectedApiRequests.push('invalid browser download request');
      await session.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
      return;
    }
    this.calls.downloads += 1;
    await session.send('Fetch.fulfillRequest', {
      requestId,
      responseCode: 200,
      responseHeaders: [
        { name: 'Cache-Control', value: 'no-store' },
        { name: 'Content-Type', value: 'video/mp4' },
        {
          name: 'Content-Disposition',
          value: 'attachment; filename="research-video-01.mp4"',
        },
      ],
      body: DOWNLOAD_BODY_BASE64,
    });
  }
}

export const test = base.extend<TestFixtures>({
  mockApi: [
    async ({ page }, use) => {
      const mockApi = new MockDownloaderApi();
      await mockApi.install(page);
      await use(mockApi);
      mockApi.verify();
    },
    { auto: true },
  ],
});

export { expect };

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import {
  type DownloadSessionRequest,
  type DownloadSessionResponse,
  type DownloadStatusResponse,
  type ResolveRequest,
  type ResolveResponse,
  type SessionResponse,
} from '@threads-downloader/contracts';
import { firstValueFrom } from 'rxjs';

import { DownloaderApi, DownloaderApiError } from './downloader-api.js';

const CSRF_TOKEN = `${'c'.repeat(42)}Q`;
const RESOLVE_ID = 'R'.repeat(32);
const CANDIDATE_ID = 'C'.repeat(32);
const DOWNLOAD_ID = 'D'.repeat(32);
const REQUEST_ID = 'Q'.repeat(32);

const sessionResponse: SessionResponse = {
  csrfToken: CSRF_TOKEN,
  expiresAt: '2026-07-25T08:30:00.000Z',
  turnstileSiteKey: '0x4AAAAAAD9Gx9nArUYJAkKJ',
};

const resolveRequest: ResolveRequest = {
  postUrl: 'https://www.threads.com/@alice/post/Abcde',
  csrfToken: CSRF_TOKEN,
  turnstileToken: 'turnstile-token',
  rightsConfirmed: true,
};

const resolveResponse: ResolveResponse = {
  resolveId: RESOLVE_ID,
  expiresAt: '2026-07-25T08:35:00.000Z',
  candidates: [{ candidateId: CANDIDATE_ID, filename: 'threads_Abcde_1.mp4', contentLength: 1024 }],
};

const downloadSessionRequest: DownloadSessionRequest = {
  resolveId: RESOLVE_ID,
  candidateId: CANDIDATE_ID,
  csrfToken: CSRF_TOKEN,
};

const downloadSessionResponse: DownloadSessionResponse = {
  downloadId: DOWNLOAD_ID,
  downloadUrl: `/api/download/${DOWNLOAD_ID}`,
  startExpiresAt: '2026-07-25T08:32:00.000Z',
};

const downloadStatusResponse: DownloadStatusResponse = {
  available: true,
  status: 'ISSUED',
  startExpiresAt: '2026-07-25T08:32:00.000Z',
  idleExpiresAt: null,
  absoluteExpiresAt: '2026-07-25T09:30:00.000Z',
  completionExpiresAt: null,
  activeStreams: 0,
  metadata: {
    filename: 'threads_Abcde_1.mp4',
    contentType: 'video/mp4',
    contentLength: 1024,
    rangeCapability: 'bytes',
  },
};

async function rejectedApiError(promise: Promise<unknown>): Promise<DownloaderApiError> {
  try {
    await promise;
  } catch (reason: unknown) {
    if (reason instanceof DownloaderApiError) {
      return reason;
    }
  }
  throw new Error('Expected a DownloaderApiError rejection.');
}

describe('DownloaderApi', () => {
  let api: DownloaderApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(DownloaderApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
  });

  it('gets an anonymous session through the exact relative route', async () => {
    const result = firstValueFrom(api.getSession());
    const request = http.expectOne('/api/session');

    expect(request.request.method).toBe('GET');
    expect(request.request.urlWithParams).toBe('/api/session');
    request.flush(sessionResponse);
    await expect(result).resolves.toEqual(sessionResponse);
  });

  it('posts only the exact resolve contract to the relative route', async () => {
    const callerValue = { ...resolveRequest, callerOnly: 'must-not-be-forwarded' };
    const result = firstValueFrom(api.resolve(callerValue));
    const request = http.expectOne('/api/resolve');

    expect(request.request.method).toBe('POST');
    expect(request.request.urlWithParams).toBe('/api/resolve');
    expect(request.request.body).toEqual(resolveRequest);
    request.flush(resolveResponse);
    await expect(result).resolves.toEqual(resolveResponse);
  });

  it('creates a download session without forwarding caller-only fields', async () => {
    const callerValue = { ...downloadSessionRequest, mediaUrl: 'must-not-be-forwarded' };
    const result = firstValueFrom(api.createDownloadSession(callerValue));
    const request = http.expectOne('/api/download-sessions');

    expect(request.request.method).toBe('POST');
    expect(request.request.urlWithParams).toBe('/api/download-sessions');
    expect(request.request.body).toEqual(downloadSessionRequest);
    request.flush(downloadSessionResponse, { status: 201, statusText: 'Created' });
    await expect(result).resolves.toEqual(downloadSessionResponse);
  });

  it('gets status only from the canonical download status route', async () => {
    const result = firstValueFrom(api.getDownloadStatus(DOWNLOAD_ID));
    const request = http.expectOne(`/api/download-status/${DOWNLOAD_ID}`);

    expect(request.request.method).toBe('GET');
    expect(request.request.urlWithParams).toBe(`/api/download-status/${DOWNLOAD_ID}`);
    request.flush(downloadStatusResponse);
    await expect(result).resolves.toEqual(downloadStatusResponse);
  });

  it.each([
    'D'.repeat(31),
    'D'.repeat(33),
    `${'D'.repeat(32)}?debug=1`,
    `${'D'.repeat(32)}#fragment`,
    `${'D'.repeat(16)}%44${'D'.repeat(15)}`,
    `/api/download-status/${DOWNLOAD_ID}`,
    `https://threads.pylot.dev/api/download-status/${DOWNLOAD_ID}`,
    '',
  ])('rejects a non-canonical download ID before transport: %s', async (downloadId) => {
    const failure = await rejectedApiError(firstValueFrom(api.getDownloadStatus(downloadId)));

    expect(failure).toEqual({
      name: 'DownloaderApiError',
      code: 'CLIENT_REQUEST_INVALID',
      message: '下載識別碼格式不正確。',
      requestId: null,
    });
    http.expectNone((request) => request.url.includes('/api/download-status'));
  });

  it('maps a decoded server error without retaining transport details', async () => {
    const result = firstValueFrom(api.resolve(resolveRequest));
    const request = http.expectOne('/api/resolve');
    request.flush(
      {
        error: {
          code: 'MEDIA_NOT_FOUND',
          message: '找不到可下載的影片。',
          requestId: REQUEST_ID,
        },
      },
      {
        status: 422,
        statusText: 'Unprocessable Content',
        headers: { 'x-private-upstream': 'private-header' },
      },
    );

    const failure = await rejectedApiError(result);
    expect(failure).toEqual({
      name: 'DownloaderApiError',
      code: 'MEDIA_NOT_FOUND',
      message: '找不到可下載的影片。',
      requestId: REQUEST_ID,
    });
    expect('stack' in failure).toBe(false);
    expect('headers' in failure).toBe(false);
    expect('error' in failure).toBe(false);
    expect(JSON.stringify(failure)).not.toContain('private-header');
  });

  it('fails closed on a malformed success response without exposing its body', async () => {
    const result = firstValueFrom(api.getSession());
    const request = http.expectOne('/api/session');
    request.flush({ ...sessionResponse, rawId: 'private-session-id' });

    const failure = await rejectedApiError(result);
    expect(failure).toEqual({
      name: 'DownloaderApiError',
      code: 'CLIENT_UNAVAILABLE',
      message: '服務暫時無法使用，請稍後再試。',
      requestId: null,
    });
    expect(JSON.stringify(failure)).not.toContain('private-session-id');
  });

  it('uses the same fixed safe failure for malformed errors and network failures', async () => {
    const malformedResult = firstValueFrom(api.getSession());
    http.expectOne('/api/session').flush(
      {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'https://video.cdninstagram.com/video.mp4?token=private',
          requestId: REQUEST_ID,
        },
      },
      { status: 500, statusText: 'Internal Server Error' },
    );
    const malformed = await rejectedApiError(malformedResult);

    const networkResult = firstValueFrom(api.getSession());
    http.expectOne('/api/session').error(new ProgressEvent('error'));
    const network = await rejectedApiError(networkResult);

    for (const failure of [malformed, network]) {
      expect(failure).toEqual({
        name: 'DownloaderApiError',
        code: 'CLIENT_UNAVAILABLE',
        message: '服務暫時無法使用，請稍後再試。',
        requestId: null,
      });
      expect(JSON.stringify(failure)).not.toContain('cdninstagram');
      expect('stack' in failure).toBe(false);
    }
  });
});

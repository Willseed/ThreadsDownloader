import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { type SessionResponse } from '@threads-downloader/contracts';
import { of, Subject, throwError } from 'rxjs';
import type { Mock } from 'vitest';

import { DownloaderApi, DownloaderApiError } from '../../core/api/downloader-api.js';
import {
  BrowserDownloadHandoff,
  DOWNLOAD_HANDOFF_MESSAGE,
} from '../../core/download/browser-download-handoff.js';
import { type DownloaderChallengeHandle, DownloaderWorkflow } from './downloader-workflow.js';

const CSRF_TOKEN = `${'c'.repeat(42)}Q`;
const RESOLVE_ID = 'R'.repeat(32);
const CANDIDATE_ID = 'C'.repeat(32);
const OTHER_CANDIDATE_ID = 'E'.repeat(32);
const DOWNLOAD_ID = 'D'.repeat(32);
const OTHER_DOWNLOAD_ID = 'F'.repeat(32);
const REQUEST_ID = 'Q'.repeat(32);
const SITE_KEY = '0x4AAAAAAD9Gx9nArUYJAkKJ';
const NEXT_CSRF_TOKEN = `${'n'.repeat(42)}Q`;
const NEXT_SITE_KEY = '0x4AAAAAAD9Gx9nArUYJAkLJ';

const sessionResponse: SessionResponse = {
  csrfToken: CSRF_TOKEN,
  expiresAt: '2026-07-25T08:30:00.000Z',
  turnstileSiteKey: SITE_KEY,
};

const nextSessionResponse: SessionResponse = {
  csrfToken: NEXT_CSRF_TOKEN,
  expiresAt: '2026-07-25T09:30:00.000Z',
  turnstileSiteKey: NEXT_SITE_KEY,
};

const resolveResponse = {
  resolveId: RESOLVE_ID,
  expiresAt: '2026-07-25T08:35:00.000Z',
  candidates: [
    {
      candidateId: CANDIDATE_ID,
      filename: 'threads_Abcde_1.mp4',
      contentLength: 1024,
      width: 1920,
      height: 1080,
      duration: 12.5,
    },
  ],
} as const;

const downloadResponse = {
  downloadId: DOWNLOAD_ID,
  downloadUrl: `/api/download/${DOWNLOAD_ID}`,
  startExpiresAt: '2026-07-25T08:32:00.000Z',
} as const;

interface ChallengeFixture {
  readonly handle: DownloaderChallengeHandle;
  readonly reset: Mock<() => void>;
}

function challengeFixture(initialToken: string | null): ChallengeFixture {
  const token = signal(initialToken);
  const reset = vi.fn<() => void>(() => token.set(null));
  return {
    handle: { token: token.asReadonly(), reset },
    reset,
  };
}

describe('DownloaderWorkflow', () => {
  let workflow: DownloaderWorkflow;
  let getSession: ReturnType<typeof vi.fn>;
  let resolve: ReturnType<typeof vi.fn>;
  let createDownloadSession: ReturnType<typeof vi.fn>;
  let handoff: ReturnType<typeof vi.fn>;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    getSession = vi.fn(() => of(sessionResponse));
    resolve = vi.fn(() => of(resolveResponse));
    createDownloadSession = vi.fn(() => of(downloadResponse));
    handoff = vi.fn(() => DOWNLOAD_HANDOFF_MESSAGE);
    TestBed.configureTestingModule({
      providers: [
        DownloaderWorkflow,
        { provide: DownloaderApi, useValue: { getSession, resolve, createDownloadSession } },
        { provide: BrowserDownloadHandoff, useValue: { handoff } },
      ],
    });
    workflow = TestBed.inject(DownloaderWorkflow);
  });

  async function ready(): Promise<void> {
    await workflow.bootstrap();
  }

  async function candidates(challenge = challengeFixture('turnstile-token')): Promise<void> {
    await ready();
    workflow.attachChallenge(challenge.handle);
    await workflow.resolve(' https://www.threads.com/@alice/post/Abcde ', true);
  }

  it('bootstraps a session while exposing only the site key', async () => {
    const pending = workflow.bootstrap();
    expect(workflow.state()).toEqual({ kind: 'bootstrapping' });

    await pending;
    expect(workflow.state()).toEqual({ kind: 'ready', siteKey: SITE_KEY });
    expect(JSON.stringify(workflow.state())).not.toContain(CSRF_TOKEN);
    expect(JSON.stringify(workflow.state())).not.toContain(sessionResponse.expiresAt);
  });

  it('resolves with a one-use token and publishes only safe candidates', async () => {
    const challenge = challengeFixture('turnstile-token');
    await ready();
    workflow.attachChallenge(challenge.handle);

    await workflow.resolve(' https://www.threads.com/@alice/post/Abcde ', true);

    expect(challenge.reset).toHaveBeenCalledOnce();
    expect(challenge.handle.token()).toBeNull();
    expect(resolve).toHaveBeenCalledWith({
      postUrl: 'https://www.threads.com/@alice/post/Abcde',
      csrfToken: CSRF_TOKEN,
      turnstileToken: 'turnstile-token',
      rightsConfirmed: true,
    });
    expect(workflow.state()).toEqual({
      kind: 'candidates',
      siteKey: SITE_KEY,
      candidates: resolveResponse.candidates,
    });
    const serialized = JSON.stringify(workflow.state());
    expect(serialized).not.toContain(CSRF_TOKEN);
    expect(serialized).not.toContain(RESOLVE_ID);
    expect(serialized).not.toContain('turnstile-token');
  });

  it('keeps the token invalidated when resolve returns a safe API error', async () => {
    resolve.mockReturnValueOnce(
      throwError(
        () => new DownloaderApiError('MEDIA_NOT_FOUND', '找不到可下載的影片。', REQUEST_ID),
      ),
    );
    const challenge = challengeFixture('single-use-token');
    await ready();
    workflow.attachChallenge(challenge.handle);

    await workflow.resolve('https://threads.com/@alice/post/Abcde', true);

    expect(challenge.reset).toHaveBeenCalledOnce();
    expect(challenge.handle.token()).toBeNull();
    expect(workflow.state()).toEqual({
      kind: 'error',
      siteKey: SITE_KEY,
      code: 'MEDIA_NOT_FOUND',
      message: '找不到可下載的影片。',
      requestId: REQUEST_ID,
    });
  });

  it('clears session ownership when resolve reports an invalid session', async () => {
    resolve.mockReturnValueOnce(
      throwError(
        () => new DownloaderApiError('SESSION_INVALID', '工作階段無效，請重新建立。', REQUEST_ID),
      ),
    );
    const challenge = challengeFixture('single-use-token');
    await ready();
    workflow.attachChallenge(challenge.handle);

    await workflow.resolve('https://threads.com/@alice/post/Abcde', true);

    expect(challenge.reset).toHaveBeenCalledTimes(2);
    expect(workflow.state()).toEqual({
      kind: 'error',
      siteKey: null,
      code: 'SESSION_INVALID',
      message: '工作階段無效，請重新建立安全工作階段。',
      requestId: REQUEST_ID,
    });

    await workflow.resolve('https://threads.com/@alice/post/Abcde', true);
    expect(resolve).toHaveBeenCalledOnce();
    expect(challenge.reset).toHaveBeenCalledTimes(2);
    expect(workflow.state()).toMatchObject({
      kind: 'error',
      siteKey: null,
      code: 'CLIENT_REQUEST_INVALID',
    });
  });

  it('rejects incomplete resolve requirements without transport', async () => {
    await ready();
    for (const { rightsConfirmed, token, url } of [
      { rightsConfirmed: false, token: 'valid-token', url: 'https://threads.com/x' },
      { rightsConfirmed: true, token: null, url: 'https://threads.com/x' },
      { rightsConfirmed: true, token: 'valid-token', url: '   ' },
    ] as const) {
      const challenge = challengeFixture(token);
      workflow.attachChallenge(challenge.handle);

      await workflow.resolve(url, rightsConfirmed);

      expect(workflow.state()).toMatchObject({
        kind: 'error',
        code: 'CLIENT_REQUEST_INVALID',
        requestId: null,
      });
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  it('ignores a repeated resolve while allowing the first response to complete', async () => {
    const response = new Subject<typeof resolveResponse>();
    resolve.mockReturnValueOnce(response.asObservable());
    await ready();
    const challenge = challengeFixture('single-use-token');
    workflow.attachChallenge(challenge.handle);

    const first = workflow.resolve('https://threads.com/@alice/post/Abcde', true);
    expect(workflow.state()).toMatchObject({ kind: 'resolving' });
    const repeated = workflow.resolve('https://threads.com/@alice/post/Abcde', true);
    response.next(resolveResponse);
    response.complete();
    await Promise.all([first, repeated]);

    expect(resolve).toHaveBeenCalledOnce();
    expect(workflow.state()).toEqual({
      kind: 'candidates',
      siteKey: SITE_KEY,
      candidates: resolveResponse.candidates,
    });
  });

  it('ignores a duplicate bootstrap while the first session request is pending', async () => {
    const response = new Subject<SessionResponse>();
    getSession.mockReturnValueOnce(response.asObservable());
    const first = workflow.bootstrap();
    const repeated = workflow.bootstrap();

    expect(getSession).toHaveBeenCalledOnce();
    expect(workflow.state()).toEqual({ kind: 'bootstrapping' });
    response.next(sessionResponse);
    response.complete();
    await Promise.all([first, repeated]);

    expect(workflow.state()).toEqual({ kind: 'ready', siteKey: SITE_KEY });
  });

  it('ignores a late session response after route-owned workflow destruction', async () => {
    const response = new Subject<SessionResponse>();
    getSession.mockReturnValueOnce(response.asObservable());
    const pending = workflow.bootstrap();

    workflow.destroy();
    response.next(sessionResponse);
    response.complete();
    await pending;

    expect(workflow.state()).toEqual({ kind: 'idle' });
  });

  it('creates a session before handoff and exposes only the fixed browser message', async () => {
    const nextDownloadResponse = {
      ...downloadResponse,
      downloadId: OTHER_DOWNLOAD_ID,
      downloadUrl: `/api/download/${OTHER_DOWNLOAD_ID}`,
    } as const;
    await candidates();
    const issuance = new Subject<typeof downloadResponse>();
    createDownloadSession
      .mockReturnValueOnce(issuance.asObservable())
      .mockReturnValueOnce(of(nextDownloadResponse));
    handoff.mockReturnValueOnce('檔案已成功儲存');

    const pending = workflow.download(CANDIDATE_ID);

    expect(createDownloadSession).toHaveBeenCalledWith({
      resolveId: RESOLVE_ID,
      candidateId: CANDIDATE_ID,
      csrfToken: CSRF_TOKEN,
    });
    expect(workflow.state()).toMatchObject({ kind: 'issuing' });
    expect(handoff).not.toHaveBeenCalled();
    const repeated = workflow.download(CANDIDATE_ID);
    expect(createDownloadSession).toHaveBeenCalledOnce();
    expect(workflow.state()).toMatchObject({ kind: 'issuing' });
    issuance.next(downloadResponse);
    issuance.complete();
    await Promise.all([pending, repeated]);

    expect(handoff).toHaveBeenCalledWith(downloadResponse.downloadUrl);
    expect(workflow.state()).toEqual({
      kind: 'handed-off',
      siteKey: SITE_KEY,
      candidates: resolveResponse.candidates,
      message: '已交由瀏覽器處理；若開啟播放器，請使用瀏覽器的儲存功能。',
    });
    const serialized = JSON.stringify(workflow.state());
    expect(serialized).not.toContain(RESOLVE_ID);
    expect(serialized).not.toContain(DOWNLOAD_ID);
    expect(serialized).not.toContain(CSRF_TOKEN);
    expect(serialized).not.toContain(downloadResponse.startExpiresAt);

    await workflow.download(CANDIDATE_ID);

    expect(createDownloadSession).toHaveBeenCalledTimes(2);
    expect(handoff).toHaveBeenCalledTimes(2);
    expect(handoff).toHaveBeenLastCalledWith(nextDownloadResponse.downloadUrl);
    expect(workflow.state()).toMatchObject({ kind: 'handed-off' });
  });

  it('clears resolved state when download issuance reports an expired session', async () => {
    createDownloadSession.mockReturnValueOnce(
      throwError(
        () => new DownloaderApiError('SESSION_EXPIRED', '工作階段已過期，請重新建立。', REQUEST_ID),
      ),
    );
    const challenge = challengeFixture('single-use-token');
    await candidates(challenge);

    await workflow.download(CANDIDATE_ID);

    expect(challenge.reset).toHaveBeenCalledTimes(2);
    expect(handoff).not.toHaveBeenCalled();
    expect(workflow.state()).toEqual({
      kind: 'error',
      siteKey: null,
      code: 'SESSION_EXPIRED',
      message: '工作階段已過期，請重新建立安全工作階段。',
      requestId: REQUEST_ID,
    });

    await workflow.download(CANDIDATE_ID);
    expect(createDownloadSession).toHaveBeenCalledOnce();
    expect(handoff).not.toHaveBeenCalled();
  });

  it('bootstraps one fresh session after session ownership is invalidated', async () => {
    resolve.mockReturnValueOnce(
      throwError(
        () => new DownloaderApiError('SESSION_INVALID', '工作階段無效，請重新建立。', REQUEST_ID),
      ),
    );
    getSession.mockReturnValueOnce(of(sessionResponse));
    const refreshedSession = new Subject<SessionResponse>();
    getSession.mockReturnValueOnce(refreshedSession.asObservable());
    const staleChallenge = challengeFixture('stale-token');
    await ready();
    workflow.attachChallenge(staleChallenge.handle);
    await workflow.resolve('https://threads.com/@alice/post/Abcde', true);

    const first = workflow.bootstrap();
    const repeated = workflow.bootstrap();
    expect(getSession).toHaveBeenCalledTimes(2);
    expect(workflow.state()).toEqual({ kind: 'bootstrapping' });

    refreshedSession.next(nextSessionResponse);
    refreshedSession.complete();
    await Promise.all([first, repeated]);

    expect(workflow.state()).toEqual({ kind: 'ready', siteKey: NEXT_SITE_KEY });
    expect(staleChallenge.reset).toHaveBeenCalledTimes(2);

    const freshChallenge = challengeFixture('fresh-token');
    workflow.attachChallenge(freshChallenge.handle);
    await workflow.resolve('https://threads.com/@alice/post/NextPost', true);

    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenLastCalledWith({
      postUrl: 'https://threads.com/@alice/post/NextPost',
      csrfToken: NEXT_CSRF_TOKEN,
      turnstileToken: 'fresh-token',
      rightsConfirmed: true,
    });
    expect(freshChallenge.reset).toHaveBeenCalledOnce();
    expect(workflow.state()).toMatchObject({ kind: 'candidates', siteKey: NEXT_SITE_KEY });
  });

  it('issues a new session when a different resolved candidate is selected', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-07-25T08:31:00.000Z'));
    const otherCandidate = {
      candidateId: OTHER_CANDIDATE_ID,
      filename: 'threads_Abcde_2.mp4',
      contentLength: 2048,
    } as const;
    resolve.mockReturnValueOnce(
      of({ ...resolveResponse, candidates: [...resolveResponse.candidates, otherCandidate] }),
    );
    createDownloadSession.mockReturnValueOnce(of(downloadResponse)).mockReturnValueOnce(
      of({
        ...downloadResponse,
        downloadId: OTHER_DOWNLOAD_ID,
        downloadUrl: `/api/download/${OTHER_DOWNLOAD_ID}`,
      }),
    );
    handoff.mockImplementationOnce(() => {
      throw new Error('browser handoff failed');
    });
    await candidates();

    await workflow.download(CANDIDATE_ID);
    await workflow.download(OTHER_CANDIDATE_ID);

    expect(createDownloadSession).toHaveBeenCalledTimes(2);
    expect(createDownloadSession).toHaveBeenLastCalledWith({
      resolveId: RESOLVE_ID,
      candidateId: OTHER_CANDIDATE_ID,
      csrfToken: CSRF_TOKEN,
    });
    expect(handoff).toHaveBeenNthCalledWith(1, downloadResponse.downloadUrl);
    expect(handoff).toHaveBeenNthCalledWith(2, `/api/download/${OTHER_DOWNLOAD_ID}`);
  });

  it('starts a new resolve directly from handed-off state and discards the old handoff URL', async () => {
    await candidates();
    await workflow.download(CANDIDATE_ID);
    const nextChallenge = challengeFixture('next-turnstile-token');
    workflow.attachChallenge(nextChallenge.handle);

    await workflow.resolve('https://threads.com/@alice/post/NextPost', true);
    await workflow.download(CANDIDATE_ID);

    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenLastCalledWith({
      postUrl: 'https://threads.com/@alice/post/NextPost',
      csrfToken: CSRF_TOKEN,
      turnstileToken: 'next-turnstile-token',
      rightsConfirmed: true,
    });
    expect(createDownloadSession).toHaveBeenCalledTimes(2);
    expect(handoff).toHaveBeenCalledTimes(2);
  });

  it('rejects an unknown candidate without issuance or handoff', async () => {
    await candidates();

    await workflow.download('X'.repeat(32));

    expect(createDownloadSession).not.toHaveBeenCalled();
    expect(handoff).not.toHaveBeenCalled();
    expect(workflow.state()).toEqual({
      kind: 'error',
      siteKey: SITE_KEY,
      code: 'CLIENT_REQUEST_INVALID',
      message: '下載候選無效，請重新解析貼文。',
      requestId: null,
      candidates: resolveResponse.candidates,
    });

    await workflow.download(CANDIDATE_ID);
    expect(createDownloadSession).toHaveBeenCalledOnce();
    expect(handoff).toHaveBeenCalledOnce();
    expect(workflow.state()).toMatchObject({ kind: 'handed-off' });
  });

  it('converts a handoff failure to a fixed safe error', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-07-25T08:31:00.000Z'));
    await candidates();
    handoff.mockImplementationOnce(() => {
      throw new Error('https://video.cdninstagram.com/private.mp4?token=secret');
    });

    await workflow.download(CANDIDATE_ID);

    expect(workflow.state()).toEqual({
      kind: 'error',
      siteKey: SITE_KEY,
      code: 'CLIENT_UNAVAILABLE',
      message: '服務暫時無法使用，請稍後再試。',
      requestId: null,
      candidates: resolveResponse.candidates,
    });

    await workflow.download(CANDIDATE_ID);
    expect(createDownloadSession).toHaveBeenCalledOnce();
    expect(handoff).toHaveBeenCalledTimes(2);
    expect(workflow.state()).toMatchObject({ kind: 'handed-off' });
  });

  it('issues a fresh session when a failed handoff URL expires', async () => {
    let now = Date.parse('2026-07-25T08:31:00.000Z');
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const nextDownloadResponse = {
      ...downloadResponse,
      downloadId: OTHER_DOWNLOAD_ID,
      downloadUrl: `/api/download/${OTHER_DOWNLOAD_ID}`,
      startExpiresAt: '2026-07-25T08:34:00.000Z',
    } as const;
    createDownloadSession
      .mockReturnValueOnce(of(downloadResponse))
      .mockReturnValueOnce(of(nextDownloadResponse));
    handoff.mockImplementationOnce(() => {
      throw new Error('browser handoff failed');
    });
    await candidates();

    await workflow.download(CANDIDATE_ID);
    now = Date.parse(downloadResponse.startExpiresAt);
    await workflow.download(CANDIDATE_ID);

    expect(createDownloadSession).toHaveBeenCalledTimes(2);
    expect(createDownloadSession).toHaveBeenLastCalledWith({
      resolveId: RESOLVE_ID,
      candidateId: CANDIDATE_ID,
      csrfToken: CSRF_TOKEN,
    });
    expect(handoff).toHaveBeenCalledTimes(2);
    expect(handoff).toHaveBeenLastCalledWith(nextDownloadResponse.downloadUrl);
    expect(workflow.state()).toMatchObject({ kind: 'handed-off' });
  });

  it('detaches a challenge whose reset fails and never reuses its token', async () => {
    await ready();
    const token = signal<string | null>('stale-token');
    const reset = vi.fn<() => void>(() => {
      throw new Error('private reset detail');
    });
    workflow.attachChallenge({ token: token.asReadonly(), reset });

    await workflow.resolve('https://threads.com/@alice/post/Abcde', true);
    expect(reset).toHaveBeenCalledOnce();
    expect(resolve).not.toHaveBeenCalled();
    expect(workflow.state()).toMatchObject({
      kind: 'error',
      code: 'CLIENT_UNAVAILABLE',
      requestId: null,
    });

    await workflow.resolve('https://threads.com/@alice/post/Abcde', true);
    expect(reset).toHaveBeenCalledOnce();
    expect(resolve).not.toHaveBeenCalled();
    expect(workflow.state()).toMatchObject({
      kind: 'error',
      code: 'CLIENT_REQUEST_INVALID',
      requestId: null,
    });
  });

  it('ignores a late resolve result after destruction', async () => {
    const response = new Subject<typeof resolveResponse>();
    resolve.mockReturnValueOnce(response.asObservable());
    await ready();
    const challenge = challengeFixture('single-use-token');
    workflow.attachChallenge(challenge.handle);
    const pending = workflow.resolve('https://threads.com/@alice/post/Abcde', true);

    workflow.destroy();
    response.next(resolveResponse);
    response.complete();
    await pending;

    expect(workflow.state()).toEqual({ kind: 'idle' });
    expect(challenge.reset).toHaveBeenCalledTimes(2);
  });
});

import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  createApiError,
  decodeDownloadSessionRequest,
  decodeDownloadSessionResponse,
  decodeDownloadStatusResponse,
  type ApiError,
  type ApiErrorCode,
  type DownloadSessionRequest,
  type DownloadSessionResponse,
  type DownloadStatusMetadata,
  type DownloadStatusResponse,
  type HealthResponse,
  type ResolveCandidate,
  type ResolveRequest,
  type ResolveResponse,
  type SessionResponse,
} from '../src/index.js';

describe('contracts', () => {
  it('creates the stable API error envelope', () => {
    expect(createApiError('NOT_FOUND', '找不到請求的 API 路徑。', 'request-1')).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: '找不到請求的 API 路徑。',
        requestId: 'request-1',
      },
    });
  });

  it('keeps response discriminants type-safe', () => {
    expectTypeOf<ApiError['error']['code']>().toEqualTypeOf<ApiErrorCode>();
    expectTypeOf<HealthResponse['status']>().toEqualTypeOf<'ok'>();
    expectTypeOf<SessionResponse>().toEqualTypeOf<{
      readonly csrfToken: string;
      readonly expiresAt: string;
      readonly turnstileSiteKey: string;
    }>();
  });

  it('keeps resolve contracts and error codes exact', () => {
    expectTypeOf<ResolveRequest>().toEqualTypeOf<{
      readonly postUrl: string;
      readonly csrfToken: string;
      readonly turnstileToken: string;
      readonly rightsConfirmed: true;
    }>();
    expectTypeOf<ResolveCandidate>().toEqualTypeOf<{
      readonly candidateId: string;
      readonly filename: string;
      readonly contentLength?: number;
      readonly width?: number;
      readonly height?: number;
      readonly duration?: number;
    }>();
    expectTypeOf<ResolveResponse>().toEqualTypeOf<{
      readonly resolveId: string;
      readonly expiresAt: string;
      readonly candidates: readonly ResolveCandidate[];
    }>();
    expectTypeOf<ApiErrorCode>().toEqualTypeOf<
      | 'HOST_NOT_ALLOWED'
      | 'SESSION_INVALID'
      | 'SESSION_EXPIRED'
      | 'SESSION_UNAVAILABLE'
      | 'REQUEST_INVALID'
      | 'REQUEST_TOO_LARGE'
      | 'URL_INVALID'
      | 'RATE_LIMITED'
      | 'TURNSTILE_INVALID'
      | 'TURNSTILE_UNAVAILABLE'
      | 'THREADS_LOGIN_REQUIRED'
      | 'THREADS_ACCESS_DENIED'
      | 'THREADS_RATE_LIMITED'
      | 'THREADS_BOT_BLOCKED'
      | 'THREADS_JAVASCRIPT_REQUIRED'
      | 'MEDIA_NOT_FOUND'
      | 'RESOLVE_UNAVAILABLE'
      | 'DOWNLOAD_EXPIRED'
      | 'DOWNLOAD_CONCURRENT_LIMIT'
      | 'DOWNLOAD_RANGE_UNAVAILABLE'
      | 'DOWNLOAD_UPSTREAM_UNAVAILABLE'
      | 'DOWNLOAD_UNAVAILABLE'
      | 'NOT_FOUND'
      | 'INTERNAL_ERROR'
    >();
  });

  it('keeps the download session request and response exact', () => {
    expectTypeOf<DownloadSessionRequest>().toEqualTypeOf<{
      readonly resolveId: string;
      readonly candidateId: string;
      readonly csrfToken: string;
    }>();
    expectTypeOf<DownloadSessionResponse>().toEqualTypeOf<{
      readonly downloadId: string;
      readonly downloadUrl: string;
      readonly startExpiresAt: string;
    }>();
  });

  it('decodes canonical download session requests', () => {
    const request = {
      resolveId: 'A'.repeat(32),
      candidateId: 'b'.repeat(32),
      csrfToken: `${'c'.repeat(42)}Q`,
    };

    expect(decodeDownloadSessionRequest(request)).toEqual(request);
    for (const invalid of [
      { ...request, extra: true },
      { ...request, resolveId: 'A'.repeat(31) },
      { ...request, candidateId: `https://${'b'.repeat(32)}` },
      { ...request, csrfToken: `${'c'.repeat(42)}B` },
      { ...request, csrfToken: 1 },
      null,
    ]) {
      expect(decodeDownloadSessionRequest(invalid)).toBeNull();
    }
  });

  it('decodes only same-origin canonical download session responses', () => {
    const downloadId = '_'.repeat(32);
    const response = {
      downloadId,
      downloadUrl: `/api/download/${downloadId}`,
      startExpiresAt: '2026-07-25T08:30:00.000Z',
    };

    expect(decodeDownloadSessionResponse(response)).toEqual(response);
    for (const invalid of [
      { ...response, extra: true },
      { ...response, downloadUrl: `https://threads.pylot.dev${response.downloadUrl}` },
      { ...response, downloadUrl: `${response.downloadUrl}?url=https://cdn.example/video.mp4` },
      { ...response, downloadUrl: `/api/download/${'A'.repeat(32)}` },
      { ...response, startExpiresAt: '2026-07-25T16:30:00+08:00' },
      { ...response, startExpiresAt: '2026-02-30T08:30:00.000Z' },
    ]) {
      expect(decodeDownloadSessionResponse(invalid)).toBeNull();
    }
  });

  it('keeps public download status free of private delivery details', () => {
    expectTypeOf<DownloadStatusMetadata>().toEqualTypeOf<{
      readonly filename: string;
      readonly contentType: string;
      readonly contentLength: number | null;
      readonly rangeCapability: 'bytes' | 'none' | 'unknown';
    }>();
    expectTypeOf<DownloadStatusResponse>().toEqualTypeOf<{
      readonly available: true;
      readonly status: 'ISSUED' | 'ACTIVE' | 'INTERRUPTED' | 'COMPLETE_PENDING';
      readonly startExpiresAt: string;
      readonly idleExpiresAt: string | null;
      readonly absoluteExpiresAt: string;
      readonly completionExpiresAt: string | null;
      readonly activeStreams: number;
      readonly metadata: DownloadStatusMetadata;
    }>();
  });

  it('decodes the exact safe public status projection', () => {
    const response: DownloadStatusResponse = {
      available: true,
      status: 'COMPLETE_PENDING',
      startExpiresAt: '2026-07-25T08:32:00.000Z',
      idleExpiresAt: '2026-07-25T08:40:00.000Z',
      absoluteExpiresAt: '2026-07-25T09:30:00.000Z',
      completionExpiresAt: '2026-07-25T08:31:30.000Z',
      activeStreams: 0,
      metadata: {
        filename: 'threads_Example_1.mp4',
        contentType: 'video/mp4',
        contentLength: 1024,
        rangeCapability: 'bytes',
      },
    };

    expect(decodeDownloadStatusResponse(response)).toEqual(response);
  });

  it('rejects status leakage, invalid state shapes, and unsafe metadata', () => {
    const active = {
      available: true,
      status: 'ACTIVE',
      startExpiresAt: '2026-07-25T08:32:00.000Z',
      idleExpiresAt: '2026-07-25T08:40:00.000Z',
      absoluteExpiresAt: '2026-07-25T09:30:00.000Z',
      completionExpiresAt: null,
      activeStreams: 1,
      metadata: {
        filename: 'threads_Example_1.mp4',
        contentType: 'video/mp4',
        contentLength: null,
        rangeCapability: 'unknown',
      },
    };

    expect(decodeDownloadStatusResponse(active)).toEqual(active);
    for (const invalid of [
      { ...active, holderId: 'h'.repeat(32) },
      { ...active, finalUrl: 'https://cdn.example/video.mp4?secret=value' },
      { ...active, status: 'EXPIRED' },
      { ...active, activeStreams: 0 },
      { ...active, activeStreams: 5 },
      { ...active, completionExpiresAt: '2026-07-25T08:39:00.000Z' },
      { ...active, idleExpiresAt: '2026-07-25T09:31:00.000Z' },
      { ...active, metadata: { ...active.metadata, filename: '../video.mp4' } },
      { ...active, metadata: { ...active.metadata, contentType: 'text/html' } },
      { ...active, metadata: { ...active.metadata, contentLength: 0 } },
      { ...active, metadata: { ...active.metadata, strongEtag: '"private"' } },
      { ...active, metadata: { ...active.metadata, rangeCapability: 'multipart' } },
    ]) {
      expect(decodeDownloadStatusResponse(invalid)).toBeNull();
    }
  });
});

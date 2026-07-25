import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  createApiError,
  type ApiError,
  type ApiErrorCode,
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
      | 'NOT_FOUND'
      | 'INTERNAL_ERROR'
    >();
  });
});

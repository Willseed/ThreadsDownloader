export const API_ERROR_CODES = [
  'HOST_NOT_ALLOWED',
  'SESSION_INVALID',
  'SESSION_EXPIRED',
  'SESSION_UNAVAILABLE',
  'REQUEST_INVALID',
  'REQUEST_TOO_LARGE',
  'URL_INVALID',
  'RATE_LIMITED',
  'TURNSTILE_INVALID',
  'TURNSTILE_UNAVAILABLE',
  'THREADS_LOGIN_REQUIRED',
  'THREADS_ACCESS_DENIED',
  'THREADS_RATE_LIMITED',
  'THREADS_BOT_BLOCKED',
  'THREADS_JAVASCRIPT_REQUIRED',
  'MEDIA_NOT_FOUND',
  'RESOLVE_UNAVAILABLE',
  'NOT_FOUND',
  'INTERNAL_ERROR',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiError {
  readonly error: {
    readonly code: ApiErrorCode;
    readonly message: string;
    readonly requestId: string;
  };
}

export interface HealthResponse {
  readonly status: 'ok';
  readonly requestId: string;
}

export interface SessionResponse {
  readonly csrfToken: string;
  readonly expiresAt: string;
  readonly turnstileSiteKey: string;
}

export interface ResolveRequest {
  readonly postUrl: string;
  readonly csrfToken: string;
  readonly turnstileToken: string;
  readonly rightsConfirmed: true;
}

export interface ResolveCandidate {
  readonly candidateId: string;
  readonly filename: string;
  readonly contentLength?: number;
  readonly width?: number;
  readonly height?: number;
  readonly duration?: number;
}

export interface ResolveResponse {
  readonly resolveId: string;
  readonly expiresAt: string;
  readonly candidates: readonly ResolveCandidate[];
}

export function createApiError(code: ApiErrorCode, message: string, requestId: string): ApiError {
  return { error: { code, message, requestId } };
}

export const API_ERROR_CODES = [
  'HOST_NOT_ALLOWED',
  'SESSION_INVALID',
  'SESSION_EXPIRED',
  'SESSION_UNAVAILABLE',
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

export function createApiError(code: ApiErrorCode, message: string, requestId: string): ApiError {
  return { error: { code, message, requestId } };
}

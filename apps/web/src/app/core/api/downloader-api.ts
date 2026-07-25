import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import {
  decodeApiError,
  decodeDownloadSessionResponse,
  decodeDownloadStatusResponse,
  decodeResolveResponse,
  decodeSessionResponse,
  type ApiErrorCode,
  type DownloadSessionRequest,
  type DownloadSessionResponse,
  type DownloadStatusResponse,
  type ResolveRequest,
  type ResolveResponse,
  type SessionResponse,
} from '@threads-downloader/contracts';
import { catchError, map, throwError, type Observable } from 'rxjs';

const SESSION_PATH = '/api/session';
const RESOLVE_PATH = '/api/resolve';
const DOWNLOAD_SESSIONS_PATH = '/api/download-sessions';
const DOWNLOAD_STATUS_PATH_PREFIX = '/api/download-status/';
const CANONICAL_DOWNLOAD_ID = /^[A-Za-z0-9_-]{32}$/u;

const REQUEST_INVALID_MESSAGE = '下載識別碼格式不正確。';
const API_UNAVAILABLE_MESSAGE = '服務暫時無法使用，請稍後再試。';

type ResponseDecoder<T> = (value: unknown) => T | null;

export type DownloaderApiErrorCode = ApiErrorCode | 'CLIENT_REQUEST_INVALID' | 'CLIENT_UNAVAILABLE';

export class DownloaderApiError {
  readonly name = 'DownloaderApiError';

  constructor(
    readonly code: DownloaderApiErrorCode,
    readonly message: string,
    readonly requestId: string | null,
  ) {
    Object.freeze(this);
  }
}

function unavailableError(): DownloaderApiError {
  return new DownloaderApiError('CLIENT_UNAVAILABLE', API_UNAVAILABLE_MESSAGE, null);
}

function applicationError(reason: unknown): DownloaderApiError {
  if (reason instanceof DownloaderApiError) {
    return reason;
  }
  if (reason instanceof HttpErrorResponse) {
    const body: unknown = reason.error;
    const decoded = decodeApiError(body);
    if (decoded !== null) {
      return new DownloaderApiError(
        decoded.error.code,
        decoded.error.message,
        decoded.error.requestId,
      );
    }
  }
  return unavailableError();
}

@Injectable({ providedIn: 'root' })
export class DownloaderApi {
  private readonly http = inject(HttpClient);

  getSession(): Observable<SessionResponse> {
    return this.decode(this.http.get<unknown>(SESSION_PATH), decodeSessionResponse);
  }

  resolve(request: ResolveRequest): Observable<ResolveResponse> {
    const body: ResolveRequest = {
      postUrl: request.postUrl,
      csrfToken: request.csrfToken,
      turnstileToken: request.turnstileToken,
      rightsConfirmed: request.rightsConfirmed,
    };
    return this.decode(this.http.post<unknown>(RESOLVE_PATH, body), decodeResolveResponse);
  }

  createDownloadSession(request: DownloadSessionRequest): Observable<DownloadSessionResponse> {
    const body: DownloadSessionRequest = {
      resolveId: request.resolveId,
      candidateId: request.candidateId,
      csrfToken: request.csrfToken,
    };
    return this.decode(
      this.http.post<unknown>(DOWNLOAD_SESSIONS_PATH, body),
      decodeDownloadSessionResponse,
    );
  }

  getDownloadStatus(downloadId: string): Observable<DownloadStatusResponse> {
    if (!CANONICAL_DOWNLOAD_ID.test(downloadId)) {
      return throwError(
        () => new DownloaderApiError('CLIENT_REQUEST_INVALID', REQUEST_INVALID_MESSAGE, null),
      );
    }
    return this.decode(
      this.http.get<unknown>(`${DOWNLOAD_STATUS_PATH_PREFIX}${downloadId}`),
      decodeDownloadStatusResponse,
    );
  }

  private decode<T>(request: Observable<unknown>, decoder: ResponseDecoder<T>): Observable<T> {
    return request.pipe(
      map((body) => {
        const decoded = decoder(body);
        if (decoded === null) {
          throw unavailableError();
        }
        return decoded;
      }),
      catchError((reason: unknown) => throwError(() => applicationError(reason))),
    );
  }
}

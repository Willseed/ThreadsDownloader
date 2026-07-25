import { DOCUMENT } from '@angular/common';
import { inject, Injectable } from '@angular/core';

const CANONICAL_DOWNLOAD_URL = /^\/api\/download\/[A-Za-z0-9_-]{32}$/u;

export const DOWNLOAD_HANDOFF_MESSAGE = '已交由瀏覽器下載管理器處理。';

export class UnsafeDownloadUrlError extends Error {
  constructor() {
    super('DOWNLOAD_URL_UNSAFE');
    this.name = 'UnsafeDownloadUrlError';
  }
}

export interface DownloadHandoff {
  handoff(downloadUrl: string): string;
}

@Injectable({ providedIn: 'root' })
export class BrowserDownloadHandoff implements DownloadHandoff {
  private readonly document = inject(DOCUMENT);

  handoff(downloadUrl: string): string {
    if (!CANONICAL_DOWNLOAD_URL.test(downloadUrl)) {
      throw new UnsafeDownloadUrlError();
    }

    const anchor = this.document.createElement('a');
    anchor.setAttribute('href', downloadUrl);
    anchor.setAttribute('download', '');
    anchor.hidden = true;

    try {
      this.document.body.append(anchor);
      anchor.click();
      return DOWNLOAD_HANDOFF_MESSAGE;
    } finally {
      anchor.remove();
    }
  }
}

import { TestBed } from '@angular/core/testing';

import {
  BrowserDownloadHandoff,
  DOWNLOAD_HANDOFF_MESSAGE,
  UnsafeDownloadUrlError,
} from './browser-download-handoff.js';

const downloadId = 'A'.repeat(32);
const downloadUrl = `/api/download/${downloadId}`;

describe('BrowserDownloadHandoff', () => {
  let handoff: BrowserDownloadHandoff;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    handoff = TestBed.inject(BrowserDownloadHandoff);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('clicks a temporary same-origin download anchor and removes it', () => {
    const clickedAnchors: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clickedAnchors.push(this);
      expect(document.body.contains(this)).toBe(true);
    });

    expect(handoff.handoff(downloadUrl)).toBe(DOWNLOAD_HANDOFF_MESSAGE);
    expect(DOWNLOAD_HANDOFF_MESSAGE).toBe(
      '已交由瀏覽器處理；若開啟播放器，請使用瀏覽器的儲存功能。',
    );
    const clickedAnchor = clickedAnchors[0];
    expect(clickedAnchor).toBeDefined();
    if (clickedAnchor === undefined) {
      throw new Error('Expected the temporary anchor to be clicked.');
    }
    expect(clickedAnchor.getAttribute('href')).toBe(downloadUrl);
    expect(clickedAnchor.getAttribute('download')).toBe('');
    expect(clickedAnchor.hidden).toBe(true);
    expect(document.body.contains(clickedAnchor)).toBe(false);
  });

  it('removes the temporary anchor when the browser click fails', () => {
    const clickedAnchors: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clickedAnchors.push(this);
      throw new Error('click failed');
    });

    expect(() => handoff.handoff(downloadUrl)).toThrow('click failed');
    const clickedAnchor = clickedAnchors[0];
    expect(clickedAnchor).toBeDefined();
    if (clickedAnchor === undefined) {
      throw new Error('Expected the temporary anchor click to be attempted.');
    }
    expect(document.body.contains(clickedAnchor)).toBe(false);
  });

  it.each([
    `https://threads.pylot.dev${downloadUrl}`,
    `//threads.pylot.dev${downloadUrl}`,
    `${downloadUrl}?source=client`,
    `${downloadUrl}#fragment`,
    `/api/download/${'A'.repeat(31)}`,
    `/api/download/${'A'.repeat(33)}`,
    `/api/download/${'A'.repeat(16)}%41${'A'.repeat(15)}`,
    `/api%2Fdownload/${downloadId}`,
    `/api/download//${downloadId}`,
    `/api/download/../${downloadId}`,
    `/api/download/${downloadId}/`,
    ` ${downloadUrl}`,
    `/other/${downloadId}`,
    '',
  ])('rejects a non-canonical download URL without clicking: %s', (unsafeUrl) => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click');

    expect(() => handoff.handoff(unsafeUrl)).toThrow(UnsafeDownloadUrlError);
    expect(click).not.toHaveBeenCalled();
  });
});

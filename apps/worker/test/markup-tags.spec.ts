import { describe, expect, it } from 'vitest';

import { extractMediaTags, MarkupTagsError } from '../src/resolver/markup-tags.js';

function urls(markup: string): readonly string[] {
  return extractMediaTags(markup).map((candidate) => candidate.value.url.href);
}

function expectMarkupError(markup: string, code: string): void {
  try {
    extractMediaTags(markup);
    throw new Error('expected markup error');
  } catch (error) {
    expect(error).toBeInstanceOf(MarkupTagsError);
    expect((error as MarkupTagsError).code).toBe(code);
    expect((error as Error).message).not.toContain(markup);
  }
}

describe('extractMediaTags', () => {
  it('parses case-insensitive tags and attributes in any order or quote style', () => {
    const markup = [
      `<META CONTENT='https://cdninstagram.com/meta.mp4?a=1&amp;b=&quot;x&quot;' PROPERTY='OG:VIDEO:URL'>`,
      '<ViDeO data-id="1" SRC=https&#58;&#x2f;&#x2f;cdninstagram.com/video.mp4></vIdEo>',
    ].join('');

    expect(extractMediaTags(markup).map(({ source }) => source)).toEqual(['og:video:url', 'video']);
    expect(urls(markup)).toEqual([
      'https://cdninstagram.com/meta.mp4?a=1&b=%22x%22',
      'https://cdninstagram.com/video.mp4',
    ]);
  });

  it('collects source tags only while nested within a video', () => {
    const markup = [
      '<source src="https://cdninstagram.com/outside-before.mp4">',
      '<video src="https://cdninstagram.com/video.mp4">',
      '<video><source src="https://cdninstagram.com/nested.mp4"></video>',
      '<source src="https://cdninstagram.com/outer.mp4">',
      '</video>',
      '<source src="https://cdninstagram.com/outside-after.mp4">',
    ].join('');

    expect(urls(markup)).toEqual([
      'https://cdninstagram.com/video.mp4',
      'https://cdninstagram.com/nested.mp4',
      'https://cdninstagram.com/outer.mp4',
    ]);
  });

  it('orders priority buckets independently of document order', () => {
    const markup = [
      '<video><source src="https://cdninstagram.com/source.mp4"></video>',
      '<video src="https://cdninstagram.com/video.mp4"></video>',
      '<meta name="og:video:secure_url" content="https://cdninstagram.com/secure.mp4">',
      '<meta content="https://cdninstagram.com/url.mp4" property="og:video:url">',
      '<meta property="og:video" content="https://cdninstagram.com/base.mp4">',
    ].join('');

    expect(extractMediaTags(markup).map(({ source }) => source)).toEqual([
      'og:video',
      'og:video:url',
      'og:video:secure_url',
      'video',
      'source',
    ]);
  });

  it('deduplicates canonical CDN URLs and keeps the highest-priority source', () => {
    const markup = [
      '<video src="https://CDNINSTAGRAM.com/media.mp4?a=1&amp;b=2"></video>',
      '<meta property="og:video" content="https://cdninstagram.com/media.mp4?a=1&#38;b=2">',
    ].join('');

    const candidates = extractMediaTags(markup);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.source).toBe('og:video');
    expect(candidates[0]?.value.url.href).toBe('https://cdninstagram.com/media.mp4?a=1&b=2');
  });

  it('limits output to ten candidates after priority ordering', () => {
    const markup = Array.from(
      { length: 12 },
      (_, index) =>
        `<meta property="og:video" content="https://cdninstagram.com/${String(index)}.mp4">`,
    ).join('');

    expect(urls(markup)).toEqual(
      Array.from({ length: 10 }, (_, index) => `https://cdninstagram.com/${String(index)}.mp4`),
    );
  });

  it('ignores tags inside comments and non-exact metadata names', () => {
    const markup = [
      'ordinary text: 1 < 2 and 3 > 1',
      '<!-- <meta property="og:video" content="https://cdninstagram.com/comment.mp4"> -->',
      '<meta property="prefix-og:video" content="https://cdninstagram.com/prefix.mp4">',
      '<meta property="og:video:width" content="https://cdninstagram.com/width.mp4">',
      '<meta data-property="og:video" content="https://cdninstagram.com/data.mp4">',
    ].join('');

    expect(extractMediaTags(markup)).toEqual([]);
  });

  it('ignores invalid candidates, including attacker-controlled CDN suffixes', () => {
    const markup = [
      '<meta property="og:video" content="https://cdninstagram.com.attacker.example/a.mp4">',
      '<video src="https://fake-cdninstagram.com/b.mp4"></video>',
      '<video src="https://media.cdninstagram.com/good.mp4"></video>',
    ].join('');

    expect(urls(markup)).toEqual(['https://media.cdninstagram.com/good.mp4']);
  });

  it('returns safe typed errors for oversized and malformed structural input', () => {
    const oversized = 'x'.repeat(2 * 1024 * 1024 + 1);
    expectMarkupError(oversized, 'MARKUP_TOO_LARGE');
    expectMarkupError('<video src="unterminated>', 'MARKUP_STRUCTURE_LIMIT');
    expectMarkupError('<!-- unterminated', 'MARKUP_STRUCTURE_LIMIT');
  });
});

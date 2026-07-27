import { describe, expect, it } from 'vitest';

import { MarkupTagsError, MAX_MARKUP_BYTES } from '../src/resolver/markup-tags.js';
import { extractMediaCandidates } from '../src/resolver/structured-media.js';

const good = (name: string): string => `https://cdninstagram.com/${name}.mp4`;

function jsonScript(value: unknown, type?: string): string {
  const attribute = type === undefined ? '' : ` type="${type}"`;
  return `<script${attribute}>${JSON.stringify(value)}</script>`;
}

function urls(markup: string): readonly string[] {
  return extractMediaCandidates(markup).map((candidate) => candidate.value.url.href);
}

function valueAtDepth(depth: number, url: string): unknown {
  let value: unknown = url;
  for (let current = 0; current < depth; current += 1) {
    value = current === 0 ? { url: value } : { child: value };
  }
  return value;
}

function nodeBoundary(nulls: number, url: string): unknown {
  return [{ url }, ...Array.from({ length: nulls }, () => null)];
}

describe('extractMediaCandidates', () => {
  it('orders HTML, JSON-LD, hydration, and other JSON independently of document order', () => {
    const markup = [
      jsonScript({ url: good('hydration') }, 'APPLICATION/JSON'),
      jsonScript({ url: good('other') }, 'text/javascript'),
      '<video src="https://cdninstagram.com/html.mp4"></video>',
      jsonScript({ url: good('json-ld') }, ' application/ld+json '),
    ].join('');

    expect(extractMediaCandidates(markup).map(({ source }) => source)).toEqual([
      'video',
      'json-ld',
      'application-json',
      'json',
    ]);
    expect(urls(markup)).toEqual([good('html'), good('json-ld'), good('hydration'), good('other')]);
  });

  it('preserves document order within each structured bucket', () => {
    const markup = [
      jsonScript({ url: good('first') }, 'application/ld+json'),
      jsonScript({ url: good('second') }, 'application/ld+json'),
      jsonScript({ url: good('third') }, 'application/json'),
    ].join('');

    expect(urls(markup)).toEqual([good('first'), good('second'), good('third')]);
  });

  it('traverses root objects and arrays using only the exact candidate keys', () => {
    const markup = jsonScript(
      [
        { contentUrl: good('content'), contenturl: good('wrong-case') },
        { nested: { video_url: good('snake'), videoUrl: good('camel') } },
        { src: good('src'), url: good('url'), href: good('href') },
        { url: 42, src: null },
      ],
      'application/json',
    );

    expect(urls(markup)).toEqual([
      good('content'),
      good('snake'),
      good('camel'),
      good('src'),
      good('url'),
    ]);
    expect(urls(jsonScript(good('root-string'), 'application/json'))).toEqual([]);
  });

  it('accepts only a whole valid JSON value and never interprets script syntax', () => {
    const candidate = JSON.stringify({ url: good('valid') });
    const markup = [
      `<script>window.data = ${candidate}</script>`,
      `<script>${candidate};</script>`,
      `<script>callback(${candidate})</script>`,
      `<script>{url:'${good('json5')}',}</script>`,
      `<script>noise ${candidate} suffix</script>`,
      `<script><!--${candidate}--></script>`,
      `<script>${candidate}</script>`,
    ].join('');

    expect(urls(markup)).toEqual([good('valid')]);
  });

  it('isolates malformed and over-limit payloads from valid siblings', () => {
    const markup = [
      '<script type="application/ld+json">{"url":</script>',
      jsonScript({ url: good('after-malformed') }, 'application/ld+json'),
      jsonScript({ url: good('too-deep'), child: valueAtDepth(13, good('hidden')) }),
      jsonScript({ url: good('after-limit') }),
    ].join('');

    expect(urls(markup)).toEqual([good('after-malformed'), good('after-limit')]);
  });

  it('enforces depth twelve atomically and rejects depth thirteen', () => {
    expect(urls(jsonScript(valueAtDepth(12, good('depth-12'))))).toEqual([good('depth-12')]);
    expect(
      urls(jsonScript({ url: good('must-rollback'), nested: valueAtDepth(13, good('depth-13')) })),
    ).toEqual([]);
  });

  it('enforces the 10,000-node boundary atomically', () => {
    expect(urls(jsonScript(nodeBoundary(9_997, good('node-10000'))))).toEqual([good('node-10000')]);
    expect(urls(jsonScript(nodeBoundary(9_998, good('must-rollback'))))).toEqual([]);
  });

  it('enforces 4,096-code-unit keys and strings atomically', () => {
    const exactKey = 'k'.repeat(4096);
    const oversizedKey = 'k'.repeat(4097);
    expect(urls(jsonScript({ url: good('exact'), [exactKey]: 'x'.repeat(4096) }))).toEqual([
      good('exact'),
    ]);
    expect(urls(jsonScript({ url: good('string-rollback'), padding: 'x'.repeat(4097) }))).toEqual(
      [],
    );
    expect(urls(jsonScript({ url: good('key-rollback'), [oversizedKey]: true }))).toEqual([]);
  });

  it('canonically deduplicates across HTML and structured buckets', () => {
    const markup = [
      '<meta property="og:video" content="https://CDNINSTAGRAM.com/a/../same.mp4">',
      jsonScript({ url: 'https://cdninstagram.com:443/same.mp4' }, 'application/ld+json'),
      jsonScript({ url: good('unique') }, 'application/json'),
    ].join('');

    expect(urls(markup)).toEqual([good('same'), good('unique')]);
    expect(extractMediaCandidates(markup)[0]?.source).toBe('og:video');
  });

  it('caps the combined canonical result at ten without charging duplicates', () => {
    const structured = Array.from({ length: 12 }, (_, index) => ({
      url: index === 0 ? good('html-0') : good(`json-${String(index)}`),
    }));
    const markup = [
      '<video src="https://cdninstagram.com/html-0.mp4"></video>',
      '<video src="https://cdninstagram.com/html-1.mp4"></video>',
      jsonScript(structured, 'application/ld+json'),
    ].join('');

    expect(urls(markup)).toEqual([
      good('html-0'),
      good('html-1'),
      ...Array.from({ length: 8 }, (_, index) => good(`json-${String(index + 1)}`)),
    ]);
  });

  it('ignores unsafe URLs, prototype-like keys, and unrelated strings', () => {
    const markup = jsonScript({
      url: 'https://cdninstagram.com.attacker.example/video.mp4',
      ['__proto__']: good('prototype'),
      constructor: good('constructor'),
      description: good('ordinary'),
      nested: { href: good('href'), contentUrl: good('accepted') },
    });

    expect(urls(markup)).toEqual([good('accepted')]);
    expect(Object.prototype).not.toHaveProperty('url');
  });

  it('handles case-insensitive script tags and attributes while ignoring comments', () => {
    const markup = [
      `<!-- ${jsonScript({ url: good('comment') }, 'application/ld+json')} -->`,
      `<ScRiPt data-kind="x" TyPe='APPLICATION/LD+JSON'>${JSON.stringify({
        text: `<meta property="og:video" content="${good('fake-tag')}">`,
        url: good('case'),
      })}</sCrIpT>`,
    ].join('');

    expect(urls(markup)).toEqual([good('case')]);
  });

  it('fails safely for an unterminated script payload', () => {
    expect(() =>
      extractMediaCandidates('<SCRIPT type="application/json">{"url":"secret"}'),
    ).toThrowError(MarkupTagsError);
    try {
      extractMediaCandidates('<SCRIPT type="application/json">{"url":"secret"}');
    } catch (error: unknown) {
      expect((error as MarkupTagsError).code).toBe('MARKUP_STRUCTURE_LIMIT');
      expect((error as Error).message).not.toContain('secret');
    }
  });

  it('enforces the raw UTF-8 byte limit through the public parser', () => {
    const oversized = 'é'.repeat(MAX_MARKUP_BYTES / 2 + 1);
    expect(oversized.length).toBeLessThan(MAX_MARKUP_BYTES);

    expect(() => extractMediaCandidates(oversized)).toThrowError(
      expect.objectContaining({ code: 'MARKUP_TOO_LARGE' }),
    );
  });
});

import { describe, expect, it } from 'vitest';

import {
  createRenderedThreadsMediaResolver,
  RENDERED_RESOLVER_BUDGET_MS,
  RenderedThreadsMediaResolverError,
  type RenderedThreadsMediaResolverErrorCode,
  type RenderedThreadsPagePort,
} from '../src/resolver/rendered-threads-media.js';
import { parseThreadsPostUrl } from '../src/security/upstream-policy.js';

const insecureHttp = 'http:';
const CANONICAL_URL = 'https://www.threads.com/@alice/post/Abcde';
const USERNAME_REDACTED_URL = 'https://www.threads.com/@/post/Abcde';
const TARGET_URL = 'https://www.threads.com/@alice/post/Abcde/media';
const PRIVATE_URL =
  'https://instagram.ftpe7-2.fna.fbcdn.net/media/video.mp4?token=private-render-token';
const post = parseThreadsPostUrl('https://www.threads.com/@alice/post/Abcde?fixture=input');

interface PrimitiveCandidate {
  readonly source: 'rendered-source' | 'rendered-video';
  readonly url: string;
}

function renderedPage(
  candidates: readonly PrimitiveCandidate[] = [],
  canonicalUrls: readonly unknown[] = [CANONICAL_URL],
  openGraphUrls: readonly unknown[] = [CANONICAL_URL],
): Record<string, unknown> {
  return {
    canonicalUrls,
    openGraphUrls,
    candidateSources: candidates.map(({ source }) => source),
    candidateUrls: candidates.map(({ url }) => url),
  };
}

function pageReturning(
  value: unknown | ((url: string) => unknown | Promise<unknown>),
  calls: string[] = [],
): RenderedThreadsPagePort {
  return {
    async render(url) {
      calls.push(url);
      return typeof value === 'function' ? value(url) : value;
    },
  };
}

async function expectResolverError(
  action: Promise<unknown>,
  code: RenderedThreadsMediaResolverErrorCode,
  secrets: readonly string[] = [],
): Promise<void> {
  let caught: unknown;
  try {
    await action;
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RenderedThreadsMediaResolverError);
  expect(caught).toMatchObject({ code, message: code });
  for (const secret of secrets) {
    expect((caught as Error).message).not.toContain(secret);
  }
}

describe('rendered Threads media resolver', () => {
  it('renders only the server-built canonical /media URL within the session budget', async () => {
    const calls: string[] = [];
    const page = pageReturning(
      renderedPage([{ source: 'rendered-video', url: PRIVATE_URL }]),
      calls,
    );

    const result = await createRenderedThreadsMediaResolver({ page }).resolve(post);

    expect(result.candidates).toHaveLength(1);
    expect(calls).toEqual([TARGET_URL]);
    expect(calls[0]).not.toContain('fixture');
    expect(RENDERED_RESOLVER_BUDGET_MS).toBe(68_000);
  });

  it('accepts mutually consistent username-redacted identity for the exact shortcode', async () => {
    const page = renderedPage(
      [{ source: 'rendered-video', url: PRIVATE_URL }],
      [USERNAME_REDACTED_URL],
      [USERNAME_REDACTED_URL],
    );

    await expect(
      createRenderedThreadsMediaResolver({ page: pageReturning(page) }).resolve(post),
    ).resolves.toHaveProperty('candidates.length', 1);
  });

  it.each([
    ['missing canonical', renderedPage([], [])],
    ['duplicate canonical', renderedPage([], [CANONICAL_URL, CANONICAL_URL])],
    ['foreign canonical', renderedPage([], ['https://www.threads.com/@alice/post/Related'])],
    ['identity disagreement', renderedPage([], [USERNAME_REDACTED_URL], [CANONICAL_URL])],
    ['redacted mismatched shortcode', renderedPage([], ['https://www.threads.com/@/post/Other'])],
    ['redacted case-changed shortcode', renderedPage([], ['https://www.threads.com/@/post/abcde'])],
    ['redacted encoded shortcode', renderedPage([], ['https://www.threads.com/@/post/Abcd%65'])],
    ['redacted HTTP', renderedPage([], [`${insecureHttp}//www.threads.com/@/post/Abcde`])],
    [
      'redacted lookalike host',
      renderedPage([], ['https://www.threads.com.attacker.example/@/post/Abcde']),
    ],
    ['redacted explicit port', renderedPage([], ['https://www.threads.com:443/@/post/Abcde'])],
    ['redacted query', renderedPage([], [`${USERNAME_REDACTED_URL}?view=media`])],
    ['redacted fragment', renderedPage([], [`${USERNAME_REDACTED_URL}#media`])],
    ['redacted trailing slash', renderedPage([], [`${USERNAME_REDACTED_URL}/`])],
  ] as const)('rejects %s identity evidence', async (_name, value) => {
    await expectResolverError(
      createRenderedThreadsMediaResolver({ page: pageReturning(value) }).resolve(post),
      'RENDERED_RESPONSE_INVALID',
      ['Related'],
    );
  });

  it.each([
    ['extra field', { ...renderedPage(), provider: 'private-provider-detail' }],
    [
      'oversized identity',
      renderedPage([], [`https://www.threads.com/@alice/post/${'a'.repeat(4_097)}`]),
    ],
    ['non-array candidate URLs', { ...renderedPage(), candidateUrls: PRIVATE_URL }],
    [
      'invalid candidate source',
      {
        ...renderedPage(),
        candidateSources: ['provider-private-source'],
        candidateUrls: [PRIVATE_URL],
      },
    ],
    [
      'mismatched candidate arrays',
      { ...renderedPage(), candidateSources: ['rendered-video'], candidateUrls: [] },
    ],
    [
      'too many candidates',
      renderedPage(
        Array.from({ length: 17 }, (_, index) => ({
          source: 'rendered-video' as const,
          url: `https://video.cdninstagram.com/${String(index)}.mp4`,
        })),
      ),
    ],
    [
      'oversized candidate value',
      renderedPage([
        { source: 'rendered-video', url: `https://video.cdninstagram.com/${'a'.repeat(4_097)}` },
      ]),
    ],
  ] as const)('rejects a malformed primitive envelope: %s', async (_name, value) => {
    await expectResolverError(
      createRenderedThreadsMediaResolver({ page: pageReturning(value) }).resolve(post),
      'RENDERED_RESPONSE_INVALID',
      ['private-provider-detail', 'provider-private-source', PRIVATE_URL],
    );
  });

  it('keeps three unique candidates in DOM order while filtering unsafe and duplicate URLs', async () => {
    const urls = Array.from(
      { length: 3 },
      (_, index) =>
        `https://video.cdninstagram.com/${String(index)}.mp4?token=private-${String(index)}`,
    );
    const page = renderedPage([
      { source: 'rendered-video', url: 'https://attacker.example/blocked.mp4' },
      { source: 'rendered-video', url: urls[0]! },
      { source: 'rendered-source', url: urls[1]! },
      { source: 'rendered-video', url: urls[2]! },
      { source: 'rendered-video', url: ` ${urls[1]!} ` },
    ]);

    const result = await createRenderedThreadsMediaResolver({ page: pageReturning(page) }).resolve(
      post,
    );

    expect(result.candidates.map(({ source, value }) => [source, value.url.href])).toEqual([
      ['rendered-video', urls[0]],
      ['rendered-source', urls[1]],
      ['rendered-video', urls[2]],
    ]);
  });

  it('maps session failures to one typed safe unavailable result', async () => {
    const secret = 'private-browser-session-detail';
    await expectResolverError(
      createRenderedThreadsMediaResolver({
        page: pageReturning(() => Promise.reject(new Error(secret))),
      }).resolve(post),
      'RENDERED_UNAVAILABLE',
      [secret],
    );
  });

  it('reports no media only after a valid identity-bound empty envelope', async () => {
    await expectResolverError(
      createRenderedThreadsMediaResolver({ page: pageReturning(renderedPage()) }).resolve(post),
      'RENDERED_MEDIA_NOT_FOUND',
    );
  });
});

import { describe, expect, it, vi } from 'vitest';

import {
  decideRedirect,
  parseCdnUrl,
  parseThreadsPostUrl,
  upstreamHeaders,
  UpstreamPolicyError,
} from '../src/security/upstream-policy.js';

const insecureHttp = 'http:';

function expectPolicyError(action: () => unknown, code: string, secret: string): void {
  try {
    action();
    throw new Error('expected policy error');
  } catch (error) {
    expect(error).toBeInstanceOf(UpstreamPolicyError);
    expect((error as UpstreamPolicyError).code).toBe(code);
    expect((error as Error).message).not.toContain(secret);
  }
}

describe('parseThreadsPostUrl', () => {
  it.each([
    ['https://threads.com/@alice/post/Abcde_1?utm=source', 'alice', 'Abcde_1'],
    ['https://www.threads.net/@a.b/post/abcde-1/', 'a.b', 'abcde-1'],
  ])('canonicalizes supported Threads links', (input, username, shortcode) => {
    expect(parseThreadsPostUrl(input)).toEqual({
      canonicalUrl: `https://www.threads.com/@${username}/post/${shortcode}`,
      username,
      shortcode,
    });
  });

  it.each([
    `${insecureHttp}//threads.com/@alice/post/Abcde`,
    'https://threads.com:444/@alice/post/Abcde',
    'https://user@threads.com/@alice/post/Abcde',
    'https://threads.com/@alice/post/Abcde#fragment',
    'https://threads.com/@alice/post/Abcde/extra',
    'https://threads.com/@alice/post/Abcde//',
    'https://threads.com/%40alice/post/Abcde',
    'https://threads.com/@alice/post/Abc%2Fde',
    'https://threads.com/@用戶/post/Abcde',
    'https://threads.com/@alice/post/abcd',
    `https://threads.com/@alice/post/${'a'.repeat(65)}`,
  ])('rejects an invalid Threads URL without exposing it', (input) => {
    expectPolicyError(() => parseThreadsPostUrl(input), 'THREADS_URL_INVALID', input);
  });

  it('rejects oversized input', () => {
    const input = `https://threads.com/@alice/post/Abcde?${'a'.repeat(2049)}`;
    expectPolicyError(() => parseThreadsPostUrl(input), 'THREADS_URL_INVALID', input);
  });
});

describe('parseCdnUrl', () => {
  it('accepts a CDN subdomain and retains its internal query', () => {
    const parsed = parseCdnUrl('https://scontent.cdninstagram.com/media/file.jpg?token=private');
    expect(parsed.url.href).toBe('https://scontent.cdninstagram.com/media/file.jpg?token=private');
  });

  it.each([
    'https://instagram.ftpe7-2.fna.fbcdn.net/media/file.mp4?token=private',
    'https://instagram.a.fna.fbcdn.net/media/file.mp4',
    `https://instagram.${'a'.repeat(63)}.fna.fbcdn.net/media/file.mp4`,
  ])('accepts the exact observational Instagram FNA host shape: %s', (input) => {
    expect(parseCdnUrl(input).url.href).toBe(input);
  });

  it.each([
    'https://cdninstagram.com.attacker.example/file',
    'https://fake-cdninstagram.com/file',
    'https://127.0.0.1/file',
    'https://[::1]/file',
    'https://localhost/file',
    '//cdninstagram.com/file',
    `${insecureHttp}//cdninstagram.com/file`,
    'https://cdninstagram%E3%80%82com/file',
    'https://xn--cdninstagram-9za.com/file',
    'https://user@cdninstagram.com/file',
    'https://cdninstagram.com:444/file',
    'https://cdninstagram.com/file#fragment',
    'https://fbcdn.net/file',
    'https://fna.fbcdn.net/file',
    'https://instagram.fna.fbcdn.net/file',
    'https://instagram.ftpe7-2.fbcdn.net/file',
    'https://instagram.ftpe7-2.fna.fbcdn.net.attacker.example/file',
    'https://extra.instagram.ftpe7-2.fna.fbcdn.net/file',
    'https://scontent.ftpe7-2.fna.fbcdn.net/file',
    'https://instagram.-ftpe.fna.fbcdn.net/file',
    'https://instagram.ftpe-.fna.fbcdn.net/file',
    'https://instagram.ftpe_7.fna.fbcdn.net/file',
    `https://instagram.${'a'.repeat(64)}.fna.fbcdn.net/file`,
    'https://instagram.xn--ftpe-9za.fna.fbcdn.net/file',
    `${insecureHttp}//instagram.ftpe7-2.fna.fbcdn.net/file`,
    'https://user@instagram.ftpe7-2.fna.fbcdn.net/file',
    'https://instagram.ftpe7-2.fna.fbcdn.net:444/file',
    'https://instagram.ftpe7-2.fna.fbcdn.net/file#fragment',
  ])('rejects an unsafe CDN URL without exposing it', (input) => {
    expectPolicyError(() => parseCdnUrl(input), 'CDN_URL_INVALID', input);
  });
});

describe('decideRedirect', () => {
  it('validates and resolves every redirect target, including relative locations', () => {
    const validateTarget = vi.fn(parseCdnUrl);
    const decision = decideRedirect({
      status: 302,
      location: '../next.jpg?sig=private',
      currentUrl: 'https://scontent.cdninstagram.com/media/path/file.jpg',
      redirectCount: 0,
      validateTarget,
    });

    expect(decision).toMatchObject({
      kind: 'redirect',
      redirectCount: 1,
      url: new URL('https://scontent.cdninstagram.com/media/next.jpg?sig=private'),
    });
    expect(validateTarget).toHaveBeenCalledWith(
      'https://scontent.cdninstagram.com/media/next.jpg?sig=private',
    );
  });

  it.each([301, 302, 303, 307, 308])('allows redirect %i through the third follow', (status) => {
    const decision = decideRedirect({
      status,
      location: '/next',
      currentUrl: 'https://cdninstagram.com/start',
      redirectCount: 2,
      validateTarget: parseCdnUrl,
    });
    expect(decision).toMatchObject({ kind: 'redirect', redirectCount: 3 });
  });

  it('rejects the fourth redirect before validating it', () => {
    const validateTarget = vi.fn(parseCdnUrl);
    expectPolicyError(
      () =>
        decideRedirect({
          status: 302,
          location: '/next?secret=value',
          currentUrl: 'https://cdninstagram.com/start',
          redirectCount: 3,
          validateTarget,
        }),
      'REDIRECT_LIMIT',
      'secret=value',
    );
    expect(validateTarget).not.toHaveBeenCalled();
  });

  it.each([
    [200, null],
    [404, 'https://attacker.example/secret'],
  ])('stops without resolving non-redirect responses', (status, location) => {
    expect(
      decideRedirect({
        status,
        location,
        currentUrl: 'https://cdninstagram.com/start',
        redirectCount: 1,
        validateTarget: parseCdnUrl,
      }),
    ).toEqual({ kind: 'stop', redirectCount: 1 });
  });

  it.each([
    [null, 'REDIRECT_INVALID'],
    [`${insecureHttp}//[bad`, 'REDIRECT_INVALID'],
    ['https://attacker.example/?token=private', 'REDIRECT_INVALID'],
  ])('returns a safe error for invalid redirects', (location, code) => {
    expectPolicyError(
      () =>
        decideRedirect({
          status: 302,
          location,
          currentUrl: 'https://cdninstagram.com/start',
          redirectCount: 0,
          validateTarget: parseCdnUrl,
        }),
      code,
      typeof location === 'string' ? location : 'none',
    );
  });
});

describe('upstreamHeaders', () => {
  it('returns only the fixed upstream headers', () => {
    expect([...upstreamHeaders().entries()]).toEqual([
      ['accept', '*/*'],
      [
        'user-agent',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
      ],
    ]);
  });
});

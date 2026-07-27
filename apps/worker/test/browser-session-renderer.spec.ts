import { TimeoutError } from '@cloudflare/puppeteer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createBrowserSessionRenderedPagePort,
  RENDERED_ALLOWED_REQUEST_PATTERNS,
  RENDERED_BROWSER_SESSION_BUDGET_MS,
  RENDERED_BROWSER_SESSION_CLEANUP_HORIZON_MS,
  type BrowserSession,
  type BrowserSessionContext,
  type BrowserSessionLauncher,
  type BrowserSessionPage,
} from '../src/resolver/browser-session-renderer.js';
import { RESOLVE_PERMIT_LEASE_MS } from '../src/security/rate-limit.js';
import { RENDERED_FALLBACK_LEASE_BUDGET_MS } from '../src/workflows/resolve-public-media.js';

const TARGET_URL = 'https://www.threads.com/@alice/post/Abcde/media';
const CANONICAL_URL = 'https://www.threads.com/@alice/post/Abcde';
const PRIVATE_MEDIA_URL =
  'https://instagram.ftpe7-2.fna.fbcdn.net/media/video.mp4?token=private-render-token';
const INSECURE_HTTP = 'http:';
const PRIMITIVE_ENVELOPE = {
  canonicalUrls: [CANONICAL_URL],
  openGraphUrls: [CANONICAL_URL],
  candidateSources: ['rendered-video'],
  candidateUrls: [PRIVATE_MEDIA_URL],
};

type RequestHandler = Parameters<BrowserSessionPage['on']>[1];
type SessionRequest = Parameters<RequestHandler>[0];
type BrowserWorkerBinding = Parameters<BrowserSessionLauncher['launch']>[0];
type BrowserSessionHandle = Awaited<ReturnType<BrowserSessionPage['waitForFunction']>>;

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly reject: (error: unknown) => void;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

interface AttemptPlan {
  readonly closeDelayMs?: number;
  readonly closeError?: Error;
  readonly closeNever?: boolean;
  readonly createContextDelayMs?: number;
  readonly createContextError?: Error;
  readonly createContextNever?: boolean;
  readonly disposeDelayMs?: number;
  readonly disposeError?: Error;
  readonly disposeNever?: boolean;
  readonly evaluateDelayMs?: number;
  readonly evaluateError?: Error;
  readonly gotoError?: Error;
  readonly newPageError?: Error;
  readonly newPageNever?: boolean;
  readonly onGoto?: (handler: RequestHandler) => Promise<void> | void;
  readonly status?: number | null;
  readonly value?: unknown;
  readonly waitError?: Error;
}

interface AttemptHarness {
  readonly close: ReturnType<typeof vi.fn>;
  readonly context: BrowserSessionContext;
  readonly dispose: ReturnType<typeof vi.fn>;
  readonly evaluate: ReturnType<typeof vi.fn>;
  readonly goto: ReturnType<typeof vi.fn>;
  readonly newPage: ReturnType<typeof vi.fn>;
  readonly requestHandler: () => RequestHandler;
  readonly waitForFunction: ReturnType<typeof vi.fn>;
}

interface SessionPlan {
  readonly closeDelayMs?: number;
  readonly closeError?: Error;
  readonly closeNever?: boolean;
}

interface SessionHarness {
  readonly close: ReturnType<typeof vi.fn>;
  readonly contexts: readonly AttemptHarness[];
  readonly createBrowserContext: ReturnType<typeof vi.fn>;
  readonly disconnect: ReturnType<typeof vi.fn>;
  readonly session: BrowserSession;
}

function browserRun(
  fetchImplementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = () =>
    Promise.resolve(new Response(null, { status: 200 })),
): BrowserRun {
  return { fetch: fetchImplementation } as unknown as BrowserRun;
}

function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

function attempt(plan: AttemptPlan = {}, events: string[] = []): AttemptHarness {
  let registeredRequestHandler: RequestHandler | undefined;
  const dispose = vi.fn(async () => {
    events.push('dispose');
    if (plan.disposeNever === true) {
      return never<void>();
    }
    if (plan.disposeDelayMs !== undefined) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, plan.disposeDelayMs);
      });
    }
    if (plan.disposeError !== undefined) {
      throw plan.disposeError;
    }
  });
  const handle: BrowserSessionHandle = { dispose };
  const evaluate = vi.fn(async () => {
    events.push('evaluate');
    if (plan.evaluateDelayMs !== undefined) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, plan.evaluateDelayMs);
      });
    }
    if (plan.evaluateError !== undefined) {
      throw plan.evaluateError;
    }
    return plan.value ?? PRIMITIVE_ENVELOPE;
  });
  const goto = vi.fn(async () => {
    events.push('goto');
    await plan.onGoto?.(registeredRequestHandler!);
    if (plan.gotoError !== undefined) {
      throw plan.gotoError;
    }
    if (plan.status === null) {
      return null;
    }
    return { status: () => plan.status ?? 200 };
  });
  const waitForFunction = vi.fn(async () => {
    events.push('wait');
    if (plan.waitError !== undefined) {
      throw plan.waitError;
    }
    return handle;
  });
  const page: BrowserSessionPage = {
    evaluate,
    goto,
    on: vi.fn((event, handler) => {
      events.push(`on:${event}`);
      registeredRequestHandler = handler;
    }),
    setJavaScriptEnabled: vi.fn(async (enabled) => {
      events.push(`java-script:${String(enabled)}`);
    }),
    setRequestInterception: vi.fn(async (enabled) => {
      events.push(`interception:${String(enabled)}`);
    }),
    setViewport: vi.fn(async ({ height, width }) => {
      events.push(`viewport:${String(width)}x${String(height)}`);
    }),
    waitForFunction,
  };
  const newPage = vi.fn(async () => {
    events.push('newPage');
    if (plan.newPageError !== undefined) {
      throw plan.newPageError;
    }
    if (plan.newPageNever === true) {
      return never<BrowserSessionPage>();
    }
    return page;
  });
  const close = vi.fn(async () => {
    events.push('contextClose');
    if (plan.closeNever === true) {
      return never<void>();
    }
    if (plan.closeDelayMs !== undefined) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, plan.closeDelayMs);
      });
    }
    if (plan.closeError !== undefined) {
      throw plan.closeError;
    }
  });
  return {
    close,
    context: { close, newPage },
    dispose,
    evaluate,
    goto,
    newPage,
    requestHandler() {
      if (registeredRequestHandler === undefined) {
        throw new Error('REQUEST_HANDLER_NOT_REGISTERED');
      }
      return registeredRequestHandler;
    },
    waitForFunction,
  };
}

function sessionFor(
  plans: readonly AttemptPlan[] = [{}, {}],
  events: string[] = [],
  sessionPlan: SessionPlan = {},
): SessionHarness {
  const contexts = plans.map((plan) => attempt(plan, events));
  let contextIndex = 0;
  const createBrowserContext = vi.fn(async () => {
    events.push('createContext');
    const plan = plans[contextIndex];
    const context = contexts[contextIndex];
    contextIndex += 1;
    if (plan === undefined || context === undefined) {
      throw new Error('UNEXPECTED_BROWSER_CONTEXT');
    }
    if (plan.createContextDelayMs !== undefined) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, plan.createContextDelayMs);
      });
    }
    if (plan.createContextError !== undefined) {
      throw plan.createContextError;
    }
    if (plan.createContextNever === true) {
      return never<BrowserSessionContext>();
    }
    return context.context;
  });
  const close = vi.fn(async () => {
    events.push('browserClose');
    if (sessionPlan.closeNever === true) {
      return never<void>();
    }
    if (sessionPlan.closeDelayMs !== undefined) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, sessionPlan.closeDelayMs);
      });
    }
    if (sessionPlan.closeError !== undefined) {
      throw sessionPlan.closeError;
    }
  });
  const disconnect = vi.fn(async () => {
    events.push('disconnect');
  });
  return {
    close,
    contexts,
    createBrowserContext,
    disconnect,
    session: { close, createBrowserContext, disconnect },
  };
}

function launcherFor(
  sessions: readonly SessionHarness[],
  events: string[] = [],
  beforeSession?: (binding: BrowserWorkerBinding, attemptIndex: number) => Promise<void>,
): { readonly launch: ReturnType<typeof vi.fn>; readonly launcher: BrowserSessionLauncher } {
  let attemptIndex = 0;
  const launch = vi.fn(async (binding: BrowserWorkerBinding) => {
    const currentIndex = attemptIndex;
    attemptIndex += 1;
    events.push('launch');
    await beforeSession?.(binding, currentIndex);
    const current = sessions[currentIndex];
    if (current === undefined) {
      throw new Error('UNEXPECTED_BROWSER_LAUNCH');
    }
    return current.session;
  });
  return { launch, launcher: { launch } };
}

interface RequestProbe {
  readonly abort: ReturnType<typeof vi.fn>;
  readonly continueRequest: ReturnType<typeof vi.fn>;
  readonly request: SessionRequest;
  readonly url: ReturnType<typeof vi.fn>;
}

function requestProbe(
  urlValue: string,
  headers: Record<string, string> = {},
  handled: boolean | (() => boolean) = false,
): RequestProbe {
  const abort = vi.fn(async () => undefined);
  const continueRequest = vi.fn(async () => undefined);
  const url = vi.fn(() => urlValue);
  return {
    abort,
    continueRequest,
    request: {
      abort,
      continue: continueRequest,
      headers: () => headers,
      isInterceptResolutionHandled: () => (typeof handled === 'function' ? handled() : handled),
      url,
    },
    url,
  };
}

interface ReadinessPageState {
  readonly candidateUrls: readonly string[];
  readonly canonicalUrls?: readonly string[];
  readonly openGraphUrls?: readonly string[];
}

interface PageDocument {
  querySelectorAll(selector: string): readonly unknown[];
}

function attributeElement(tagName: string, attribute: string, value: string, currentSrc = '') {
  return {
    currentSrc,
    getAttribute: (requested: string) => (requested === attribute ? value : null),
    tagName,
  };
}

function readinessDocument(state: ReadinessPageState): PageDocument {
  return {
    querySelectorAll(selector: string) {
      if (selector === 'link[rel="canonical"]') {
        return (state.canonicalUrls ?? []).map((url) => attributeElement('LINK', 'href', url));
      }
      if (selector === 'meta[property="og:url"]') {
        return (state.openGraphUrls ?? []).map((url) => attributeElement('META', 'content', url));
      }
      if (selector === 'video[src], video source[src]') {
        return state.candidateUrls.map((url) => attributeElement('VIDEO', 'src', url, url));
      }
      throw new Error(`UNEXPECTED_SELECTOR:${selector}`);
    },
  };
}

function runReadinessExpression(
  expression: string,
  now: number,
  state: ReadinessPageState,
  pageGlobal: Record<string, unknown>,
): unknown {
  // eslint-disable-next-line sonarjs/code-eval -- This executes the generated in-page predicate against a sealed test harness.
  const evaluate = new Function(
    'document',
    'performance',
    'globalThis',
    `return ${expression};`,
  ) as (
    documentValue: PageDocument,
    performanceValue: { readonly now: () => number },
    globalValue: Record<string, unknown>,
  ) => unknown;
  return evaluate(readinessDocument(state), { now: () => now }, pageGlobal);
}

function extractionDocument(literalUrl: string, currentUrl: string): PageDocument {
  return {
    querySelectorAll(selector: string) {
      if (selector === 'link[rel="canonical"]') {
        return [attributeElement('LINK', 'href', CANONICAL_URL)];
      }
      if (selector === 'meta[property="og:url"]') {
        return [attributeElement('META', 'content', CANONICAL_URL)];
      }
      if (selector === 'video[src], video source[src]') {
        return [
          attributeElement('VIDEO', 'src', literalUrl, currentUrl),
          attributeElement('SOURCE', 'src', currentUrl),
        ];
      }
      throw new Error(`UNEXPECTED_SELECTOR:${selector}`);
    },
  };
}

function runExtractionExpression(
  expression: string,
  literalUrl: string,
  currentUrl: string,
): unknown {
  // eslint-disable-next-line sonarjs/code-eval -- This executes the generated primitive extractor against a sealed test DOM.
  const evaluate = new Function('document', `return ${expression};`) as (
    documentValue: PageDocument,
  ) => unknown;
  return evaluate(extractionDocument(literalUrl, currentUrl));
}

function observeSettlement(promise: Promise<unknown>): { readonly settled: () => boolean } {
  let value = false;
  void promise.then(
    () => {
      value = true;
    },
    () => {
      value = true;
    },
  );
  return { settled: () => value };
}

afterEach(() => {
  vi.useRealTimers();
});

const REDACTED_URL = 'https://www.threads.com/@/post/Abcde';
const SECOND_MEDIA_URL = 'https://video.cdninstagram.com/media/second.mp4';
const THIRD_MEDIA_URL = 'https://cdninstagram.com/media/third.mp4';

function snapshot(
  candidateUrls: readonly string[],
  identity = CANONICAL_URL,
  candidateSources: readonly ('rendered-source' | 'rendered-video')[] = candidateUrls.map(
    () => 'rendered-video' as const,
  ),
): unknown {
  return {
    canonicalUrls: [identity],
    openGraphUrls: [identity],
    candidateSources: [...candidateSources],
    candidateUrls: [...candidateUrls],
  };
}

describe('browser session rendered page adapter', () => {
  it('runs two fresh contexts in one browser, merges them, and closes every lifecycle seam', async () => {
    const events: string[] = [];
    const currentSession = sessionFor([{}, {}], events);
    const { launch, launcher } = launcherFor([currentSession], events);

    await expect(
      createBrowserSessionRenderedPagePort(browserRun(), launcher).render(TARGET_URL),
    ).resolves.toEqual(PRIMITIVE_ENVELOPE);

    expect(events).toEqual([
      'launch',
      'createContext',
      'newPage',
      'java-script:true',
      'viewport:1920x1080',
      'on:request',
      'interception:true',
      'goto',
      'wait',
      'evaluate',
      'dispose',
      'contextClose',
      'createContext',
      'newPage',
      'java-script:true',
      'viewport:1920x1080',
      'on:request',
      'interception:true',
      'goto',
      'wait',
      'evaluate',
      'dispose',
      'contextClose',
      'browserClose',
    ]);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0]).toHaveLength(2);
    expect(launch).toHaveBeenCalledWith(expect.anything(), { keep_alive: 10_000 });
    expect(currentSession.createBrowserContext).toHaveBeenCalledTimes(2);
    for (const context of currentSession.contexts) {
      expect(context.goto).toHaveBeenCalledWith(TARGET_URL, {
        timeout: 4_000,
        waitUntil: 'domcontentloaded',
      });
      expect(context.waitForFunction).toHaveBeenCalledWith(expect.any(String), {
        polling: 500,
        timeout: 8_000,
      });
      expect(context.close).toHaveBeenCalledTimes(1);
      expect(context.dispose).toHaveBeenCalledTimes(1);
    }
    expect(currentSession.close).toHaveBeenCalledTimes(1);
    expect(currentSession.disconnect).not.toHaveBeenCalled();
    expect(RENDERED_BROWSER_SESSION_BUDGET_MS).toBe(68_000);
  });

  it('merges exact full and redacted snapshots with canonical candidate deduplication in order', async () => {
    const first = snapshot([PRIVATE_MEDIA_URL, SECOND_MEDIA_URL], CANONICAL_URL, [
      'rendered-video',
      'rendered-source',
    ]);
    const second = snapshot(['  ' + SECOND_MEDIA_URL + '  ', THIRD_MEDIA_URL], REDACTED_URL, [
      'rendered-video',
      'rendered-video',
    ]);
    const currentSession = sessionFor([{ value: first }, { value: second }]);
    const { launcher } = launcherFor([currentSession]);

    await expect(
      createBrowserSessionRenderedPagePort(browserRun(), launcher).render(TARGET_URL),
    ).resolves.toEqual({
      canonicalUrls: [CANONICAL_URL],
      openGraphUrls: [CANONICAL_URL],
      candidateSources: ['rendered-video', 'rendered-source', 'rendered-video'],
      candidateUrls: [PRIVATE_MEDIA_URL, SECOND_MEDIA_URL, THIRD_MEDIA_URL],
    });
    expect(currentSession.createBrowserContext).toHaveBeenCalledTimes(2);
  });

  it('still runs context two when context one already exposes multiple rendition candidates', async () => {
    const multipleCandidates = snapshot([PRIVATE_MEDIA_URL, SECOND_MEDIA_URL, THIRD_MEDIA_URL]);
    const currentSession = sessionFor([
      { value: multipleCandidates },
      { value: multipleCandidates },
    ]);
    const { launcher } = launcherFor([currentSession]);

    const result = await createBrowserSessionRenderedPagePort(browserRun(), launcher).render(
      TARGET_URL,
    );

    expect(result).toEqual(multipleCandidates);
    expect(currentSession.createBrowserContext).toHaveBeenCalledTimes(2);
  });

  it('caps the merged exact envelope at sixteen canonical candidates', async () => {
    const urls = Array.from(
      { length: 20 },
      (_value, index) => 'https://video.cdninstagram.com/media/' + String(index) + '.mp4',
    );
    const currentSession = sessionFor([
      { value: snapshot(urls.slice(0, 10)) },
      { value: snapshot(urls.slice(10)) },
    ]);
    const { launcher } = launcherFor([currentSession]);

    const result = (await createBrowserSessionRenderedPagePort(browserRun(), launcher).render(
      TARGET_URL,
    )) as { readonly candidateUrls: readonly string[] };

    expect(result.candidateUrls).toEqual(urls.slice(0, 16));
  });

  it('uses context two after an empty readiness timeout without reacquiring the browser', async () => {
    const events: string[] = [];
    const currentSession = sessionFor(
      [{ waitError: new TimeoutError('first readiness timeout') }, {}],
      events,
    );
    const { launch, launcher } = launcherFor([currentSession], events);

    await expect(
      createBrowserSessionRenderedPagePort(browserRun(), launcher).render(TARGET_URL),
    ).resolves.toEqual(PRIMITIVE_ENVELOPE);

    expect(launch).toHaveBeenCalledTimes(1);
    expect(currentSession.createBrowserContext).toHaveBeenCalledTimes(2);
    expect(currentSession.contexts[0]!.close).toHaveBeenCalledTimes(1);
    expect(events.indexOf('contextClose')).toBeLessThan(events.lastIndexOf('createContext'));
  });

  it('closes both contexts and fails after two empty readiness timeouts', async () => {
    const currentSession = sessionFor([
      { waitError: new TimeoutError('first readiness timeout') },
      { waitError: new TimeoutError('second readiness timeout') },
    ]);
    const { launch, launcher } = launcherFor([currentSession]);

    await expect(
      createBrowserSessionRenderedPagePort(browserRun(), launcher).render(TARGET_URL),
    ).rejects.toThrow('BROWSER_SESSION_READINESS_TIMEOUT');

    expect(launch).toHaveBeenCalledTimes(1);
    expect(currentSession.contexts[0]!.close).toHaveBeenCalledTimes(1);
    expect(currentSession.contexts[1]!.close).toHaveBeenCalledTimes(1);
    expect(currentSession.close).toHaveBeenCalledTimes(1);
  });

  it('keeps a validated first candidate when optional context two stays empty', async () => {
    const currentSession = sessionFor([
      {},
      { waitError: new TimeoutError('second readiness timeout') },
    ]);
    const { launcher } = launcherFor([currentSession]);

    await expect(
      createBrowserSessionRenderedPagePort(browserRun(), launcher).render(TARGET_URL),
    ).resolves.toEqual(PRIMITIVE_ENVELOPE);
  });

  it('keeps validated candidates when optional context two is malformed or operationally fatal', async () => {
    for (const second of [
      { value: { candidateUrls: [SECOND_MEDIA_URL] } },
      { newPageError: new Error('second-context-private-detail') },
    ] as const) {
      const currentSession = sessionFor([{}, second]);
      const { launcher } = launcherFor([currentSession]);

      await expect(
        createBrowserSessionRenderedPagePort(browserRun(), launcher).render(TARGET_URL),
      ).resolves.toEqual(PRIMITIVE_ENVELOPE);
      expect(currentSession.contexts[1]!.close).toHaveBeenCalledTimes(1);
    }
  });

  it('propagates a malformed or identity-invalid first snapshot when no candidate was validated', async () => {
    const malformed = { candidateUrls: [PRIVATE_MEDIA_URL] };
    const invalidIdentity = {
      ...PRIMITIVE_ENVELOPE,
      canonicalUrls: ['https://attacker.example/post'],
      openGraphUrls: ['https://attacker.example/post'],
    };
    for (const value of [malformed, invalidIdentity]) {
      const currentSession = sessionFor([{ value }, {}]);
      const { launcher } = launcherFor([currentSession]);

      await expect(
        createBrowserSessionRenderedPagePort(browserRun(), launcher).render(TARGET_URL),
      ).resolves.toBe(value);
      expect(currentSession.createBrowserContext).toHaveBeenCalledTimes(1);
    }
  });

  it.each([
    ['newPage', { newPageError: new Error('new-page-private-detail') }],
    ['goto', { gotoError: new Error('goto-private-detail') }],
    ['wait protocol error', { waitError: new Error('wait-private-detail') }],
    ['evaluate', { evaluateError: new Error('evaluate-private-detail') }],
    ['null navigation response', { status: null }],
    ['non-200 navigation response', { status: 204 }],
  ] as const)(
    'closes and fails a first-context %s error without browser reacquisition',
    async (_name, plan) => {
      const currentSession = sessionFor([plan, {}]);
      const { launch, launcher } = launcherFor([currentSession]);

      await expect(
        createBrowserSessionRenderedPagePort(browserRun(), launcher).render(TARGET_URL),
      ).rejects.toBeInstanceOf(Error);

      expect(launch).toHaveBeenCalledTimes(1);
      expect(currentSession.contexts[0]!.close).toHaveBeenCalledTimes(1);
      expect(currentSession.createBrowserContext).toHaveBeenCalledTimes(1);
      expect(currentSession.close).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves an extracted first snapshot when dispose fails and disconnects before enrichment', async () => {
    const currentSession = sessionFor([{ disposeError: new Error('dispose-private') }, {}]);
    const { launcher } = launcherFor([currentSession]);

    await expect(
      createBrowserSessionRenderedPagePort(browserRun(), launcher).render(TARGET_URL),
    ).resolves.toEqual(PRIMITIVE_ENVELOPE);

    expect(currentSession.disconnect).toHaveBeenCalledTimes(1);
    expect(currentSession.createBrowserContext).toHaveBeenCalledTimes(1);
    expect(currentSession.contexts[0]!.close).toHaveBeenCalledTimes(1);
  });

  it('preserves an extracted snapshot when dispose exceeds the active deadline', async () => {
    vi.useFakeTimers();
    const scheduled: Promise<void>[] = [];
    const currentSession = sessionFor([{ disposeNever: true }, {}]);
    const { launcher } = launcherFor([currentSession]);
    const rendering = createBrowserSessionRenderedPagePort(browserRun(), launcher, (cleanup) =>
      scheduled.push(cleanup),
    ).render(TARGET_URL);
    const settlement = observeSettlement(rendering);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(19_999);
    expect(settlement.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(rendering).resolves.toEqual(PRIMITIVE_ENVELOPE);
    expect(currentSession.disconnect).toHaveBeenCalledTimes(1);
    expect(currentSession.createBrowserContext).toHaveBeenCalledTimes(1);
    expect(scheduled).toHaveLength(1);
  });

  it('bounds a hanging page protocol call at twenty seconds and disconnects', async () => {
    vi.useFakeTimers();
    const currentSession = sessionFor([{ newPageNever: true }, {}]);
    const { launcher } = launcherFor([currentSession]);
    const rendering = createBrowserSessionRenderedPagePort(browserRun(), launcher).render(
      TARGET_URL,
    );
    const settlement = observeSettlement(rendering);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(19_999);
    expect(settlement.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(rendering).rejects.toThrow('BROWSER_SESSION_CONTEXT_TIMEOUT');
    expect(currentSession.contexts[0]!.close).toHaveBeenCalledTimes(1);
    expect(currentSession.disconnect).toHaveBeenCalledTimes(1);
    expect(currentSession.createBrowserContext).toHaveBeenCalledTimes(1);
  });

  it('reserves four seconds for context close outside the twenty-second active deadline', async () => {
    vi.useFakeTimers();
    const currentSession = sessionFor([
      {
        waitError: new Error('wait-private-detail'),
        closeDelayMs: 3_999,
      },
      {},
    ]);
    const { launcher } = launcherFor([currentSession]);
    const rendering = createBrowserSessionRenderedPagePort(browserRun(), launcher).render(
      TARGET_URL,
    );
    const settlement = observeSettlement(rendering);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(3_998);
    expect(settlement.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(rendering).rejects.toThrow('wait-private-detail');
    expect(currentSession.contexts[0]!.close).toHaveBeenCalledTimes(1);
  });

  it('disconnects on a context-close timeout and does not start another context', async () => {
    vi.useFakeTimers();
    const currentSession = sessionFor([
      { newPageError: new Error('page-private-detail'), closeNever: true },
      {},
    ]);
    const { launcher } = launcherFor([currentSession]);
    const rendering = createBrowserSessionRenderedPagePort(browserRun(), launcher).render(
      TARGET_URL,
    );
    const outcome = rendering.then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    await vi.advanceTimersByTimeAsync(3_999);
    expect(currentSession.disconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect((await outcome).error).toMatchObject({
      message: 'BROWSER_SESSION_CONTEXT_CLOSE_TIMEOUT',
    });
    expect(currentSession.disconnect).toHaveBeenCalledTimes(1);
    expect(currentSession.createBrowserContext).toHaveBeenCalledTimes(1);
  });

  it('does not let browser-close failure erase validated downloadable candidates', async () => {
    vi.useFakeTimers();
    const currentSession = sessionFor([{}, {}], [], { closeNever: true });
    const { launcher } = launcherFor([currentSession]);
    const rendering = createBrowserSessionRenderedPagePort(browserRun(), launcher).render(
      TARGET_URL,
    );
    const settlement = observeSettlement(rendering);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(3_999);
    expect(settlement.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(rendering).resolves.toEqual(PRIMITIVE_ENVELOPE);
    expect(currentSession.close).toHaveBeenCalledTimes(1);
    expect(currentSession.disconnect).toHaveBeenCalledTimes(1);
  });

  it('retries one ordinary launch or connect rejection before using one browser', async () => {
    const currentSession = sessionFor();
    const launch = vi
      .fn<BrowserSessionLauncher['launch']>()
      .mockRejectedValueOnce(new Error('ordinary-connect-private-detail'))
      .mockResolvedValueOnce(currentSession.session);
    const rendering = createBrowserSessionRenderedPagePort(browserRun(), { launch }).render(
      TARGET_URL,
    );

    await expect(rendering).resolves.toEqual(PRIMITIVE_ENVELOPE);
    expect(launch).toHaveBeenCalledTimes(2);
    expect(currentSession.createBrowserContext).toHaveBeenCalledTimes(2);
    expect(currentSession.close).toHaveBeenCalledTimes(1);
  });

  it('does not reacquire after an absolute launch timeout and bounds late-session cleanup', async () => {
    vi.useFakeTimers();
    const lateLaunch = deferred<BrowserSession>();
    const lateSession = sessionFor([], [], { closeNever: true });
    const scheduled: Promise<void>[] = [];
    const launch = vi.fn(() => lateLaunch.promise);
    const rendering = createBrowserSessionRenderedPagePort(browserRun(), { launch }, (cleanup) =>
      scheduled.push(cleanup),
    ).render(TARGET_URL);
    const outcome = rendering.then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );

    await vi.advanceTimersByTimeAsync(7_999);
    expect(launch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await outcome).error).toMatchObject({ message: 'BROWSER_SESSION_LAUNCH_TIMEOUT' });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(scheduled).toHaveLength(1);

    lateLaunch.resolve(lateSession.session);
    await vi.advanceTimersByTimeAsync(0);
    expect(lateSession.close).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(lateSession.disconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(Promise.all(scheduled)).resolves.toEqual([undefined]);
    expect(lateSession.disconnect).toHaveBeenCalledTimes(1);
  });

  it('bounds waitUntil cleanup eighteen seconds after a late context deadline', async () => {
    vi.useFakeTimers();
    const scheduled: Promise<void>[] = [];
    const createBrowserContext = vi.fn(() => never<BrowserSessionContext>());
    const close = vi.fn(async () => undefined);
    const disconnect = vi.fn(async () => undefined);
    const session: BrowserSession = { close, createBrowserContext, disconnect };
    const launch = vi.fn(async () => session);
    const rendering = createBrowserSessionRenderedPagePort(browserRun(), { launch }, (cleanup) =>
      scheduled.push(cleanup),
    ).render(TARGET_URL);
    const outcome = rendering.then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );

    await vi.advanceTimersByTimeAsync(20_000);
    expect((await outcome).error).toMatchObject({ message: 'BROWSER_SESSION_CONTEXT_TIMEOUT' });
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(scheduled).toHaveLength(2);
    const cleanup = Promise.all(scheduled);
    const settlement = observeSettlement(cleanup);

    await vi.advanceTimersByTimeAsync(17_999);
    expect(settlement.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(cleanup).resolves.toEqual([undefined, undefined]);
  });

  it('bounds the exact second-context cleanup horizon at renderer-relative second 78', async () => {
    vi.useFakeTimers();
    const scheduled: Promise<void>[] = [];
    const currentSession = sessionFor([
      { createContextDelayMs: 20_000, closeDelayMs: 4_000 },
      { newPageNever: true },
    ]);
    let launchCount = 0;
    const launch = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 8_000);
      });
      launchCount += 1;
      if (launchCount === 1) {
        throw new Error('ordinary-launch-rejection');
      }
      return currentSession.session;
    });
    const rendering = createBrowserSessionRenderedPagePort(browserRun(), { launch }, (cleanup) =>
      scheduled.push(cleanup),
    ).render(TARGET_URL);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(scheduled).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await expect(rendering).resolves.toEqual(PRIMITIVE_ENVELOPE);
    expect(scheduled).toHaveLength(1);
    const cleanup = Promise.all(scheduled);
    const settlement = observeSettlement(cleanup);

    await vi.advanceTimersByTimeAsync(17_999);
    expect(settlement.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(cleanup).resolves.toEqual([undefined]);
    expect(settlement.settled()).toBe(true);
    expect(RENDERED_BROWSER_SESSION_CLEANUP_HORIZON_MS).toBe(78_000);
    expect(RENDERED_BROWSER_SESSION_CLEANUP_HORIZON_MS).toBeLessThan(
      RENDERED_FALLBACK_LEASE_BUDGET_MS,
    );
    expect(RENDERED_FALLBACK_LEASE_BUDGET_MS).toBe(94_000);
    expect(RENDERED_FALLBACK_LEASE_BUDGET_MS).toBeLessThan(RESOLVE_PERMIT_LEASE_MS);
    expect(RESOLVE_PERMIT_LEASE_MS).toBe(120_000);
  });

  it('keeps the exact worst-case foreground below the exported 68-second budget', async () => {
    vi.useFakeTimers();
    const currentSession = sessionFor(
      [
        { evaluateDelayMs: 19_999, closeDelayMs: 3_999 },
        { evaluateDelayMs: 19_999, closeDelayMs: 3_999 },
      ],
      [],
      { closeDelayMs: 3_999 },
    );
    let launchCount = 0;
    const launch = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 7_999);
      });
      launchCount += 1;
      if (launchCount === 1) {
        throw new Error('ordinary-launch-rejection');
      }
      return currentSession.session;
    });
    const rendering = createBrowserSessionRenderedPagePort(browserRun(), { launch }).render(
      TARGET_URL,
    );
    const settlement = observeSettlement(rendering);

    await vi.advanceTimersByTimeAsync(67_992);
    expect(settlement.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(rendering).resolves.toEqual(PRIMITIVE_ENVELOPE);
    expect(settlement.settled()).toBe(true);
    expect(launch).toHaveBeenCalledTimes(2);
    expect(RENDERED_BROWSER_SESSION_BUDGET_MS).toBe(68_000);
  });

  it('requires stable nonempty readiness while terminal identity errors settle immediately', async () => {
    const currentSession = sessionFor();
    const { launcher } = launcherFor([currentSession]);
    await createBrowserSessionRenderedPagePort(browserRun(), launcher).render(TARGET_URL);
    const expression = currentSession.contexts[0]!.waitForFunction.mock.calls[0]?.[0] as string;
    const pageGlobal: Record<string, unknown> = {};
    const empty = { candidateUrls: [] };
    const candidateA = { candidateUrls: [PRIVATE_MEDIA_URL] };
    const candidateB = { candidateUrls: [SECOND_MEDIA_URL] };

    expect(runReadinessExpression(expression, 10_000, empty, pageGlobal)).toBe(false);
    expect(runReadinessExpression(expression, 11_000, candidateA, pageGlobal)).toBe(false);
    expect(runReadinessExpression(expression, 14_999, candidateA, pageGlobal)).toBe(false);
    expect(runReadinessExpression(expression, 15_000, candidateA, pageGlobal)).toBe(true);
    expect(runReadinessExpression(expression, 15_500, candidateB, pageGlobal)).toBe(false);
    expect(runReadinessExpression(expression, 18_499, candidateB, pageGlobal)).toBe(false);
    expect(runReadinessExpression(expression, 18_500, candidateB, pageGlobal)).toBe(true);
    expect(
      runReadinessExpression(
        expression,
        20_000,
        {
          candidateUrls: [],
          canonicalUrls: [CANONICAL_URL],
          openGraphUrls: ['https://www.threads.com/@alice/post/Other'],
        },
        {},
      ),
    ).toBe(true);
    expect(
      runReadinessExpression(
        expression,
        20_000,
        {
          candidateUrls: [],
          canonicalUrls: [CANONICAL_URL],
          openGraphUrls: [CANONICAL_URL],
        },
        {},
      ),
    ).toBe(false);
  });

  it('extracts literal video src before distinct currentSrc and retains source order', async () => {
    const literalUrl = 'https://video.cdninstagram.com/literal-video.mp4';
    const currentUrl = 'https://video.cdninstagram.com/resolved-current.mp4';
    const currentSession = sessionFor();
    const { launcher } = launcherFor([currentSession]);
    await createBrowserSessionRenderedPagePort(browserRun(), launcher).render(TARGET_URL);
    const expression = currentSession.contexts[0]!.evaluate.mock.calls[0]?.[0] as string;

    expect(runExtractionExpression(expression, literalUrl, currentUrl)).toEqual({
      canonicalUrls: [CANONICAL_URL],
      openGraphUrls: [CANONICAL_URL],
      candidateSources: ['rendered-video', 'rendered-video', 'rendered-source'],
      candidateUrls: [literalUrl, currentUrl, currentUrl],
    });
  });

  it('allows only existing HTTPS origins, strips credentials, and ignores data or handled requests', async () => {
    expect(RENDERED_ALLOWED_REQUEST_PATTERNS).toEqual([
      String.raw`^https:\/\/www\.threads\.com\/`,
      String.raw`^https:\/\/(?:[a-z0-9-]+\.)*cdninstagram\.com\/`,
      String.raw`^https:\/\/instagram\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.fna\.fbcdn\.net\/`,
    ]);
    const privateHeaders = {
      Accept: 'video/*',
      Authorization: 'Bearer private',
      COOKIE: 'session=private',
      'Proxy-Authorization': 'Basic private',
      Referer: 'https://private.example/referrer',
      REFERRER: 'https://private.example/referrer-alias',
      'X-Safe': 'preserved',
    };
    const allowed = [
      requestProbe(TARGET_URL + '?view=media', privateHeaders),
      requestProbe('https://video.cdninstagram.com/media/video.mp4?token=private', privateHeaders),
      requestProbe('https://instagram.ftpe7-2.fna.fbcdn.net/media/video.mp4', privateHeaders),
    ];
    const blocked = [
      requestProbe(INSECURE_HTTP + '//www.threads.com/@alice/post/Abcde/media'),
      requestProbe('https://alice:private@www.threads.com/@alice/post/Abcde/media'),
      requestProbe('https://www.threads.com:444/@alice/post/Abcde/media'),
      requestProbe('https://www.threads.com.attacker.example/media'),
      requestProbe('https://instagram.ftpe7-2.fna.fbcdn.net:8443/media/video.mp4'),
    ];
    const ignored = [
      requestProbe('data:text/javascript,void(0)'),
      requestProbe('https://attacker.example/already-decided', {}, true),
    ];
    const currentSession = sessionFor([
      {
        async onGoto(handler) {
          await Promise.all(
            [...allowed, ...blocked, ...ignored].map(({ request }) => handler(request)),
          );
        },
      },
      {},
    ]);
    const { launcher } = launcherFor([currentSession]);

    await createBrowserSessionRenderedPagePort(browserRun(), launcher).render(TARGET_URL);

    for (const probe of allowed) {
      expect(probe.continueRequest).toHaveBeenCalledTimes(1);
      expect(probe.continueRequest).toHaveBeenCalledWith({
        headers: { Accept: 'video/*', 'X-Safe': 'preserved' },
      });
      expect(probe.abort).not.toHaveBeenCalled();
    }
    for (const probe of blocked) {
      expect(probe.abort).toHaveBeenCalledTimes(1);
      expect(probe.abort).toHaveBeenCalledWith('blockedbyclient');
      expect(probe.continueRequest).not.toHaveBeenCalled();
    }
    for (const probe of ignored) {
      expect(probe.abort).not.toHaveBeenCalled();
      expect(probe.continueRequest).not.toHaveBeenCalled();
    }
    expect(ignored[1]?.url).not.toHaveBeenCalled();
  });

  it('awaits an interception action before its request handler settles', async () => {
    const gate = deferred<void>();
    const probe = requestProbe('https://video.cdninstagram.com/media/video.mp4');
    probe.continueRequest.mockImplementation(() => gate.promise);
    const currentSession = sessionFor();
    const { launcher } = launcherFor([currentSession]);
    await createBrowserSessionRenderedPagePort(browserRun(), launcher).render(TARGET_URL);

    const handling = currentSession.contexts[0]!.requestHandler()(probe.request);
    const settlement = observeSettlement(handling);
    await Promise.resolve();
    expect(probe.continueRequest).toHaveBeenCalledTimes(1);
    expect(settlement.settled()).toBe(false);

    gate.resolve(undefined);
    await expect(handling).resolves.toBeUndefined();
    expect(settlement.settled()).toBe(true);
  });

  it('clears successful browser-control deadlines before they can abort', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fetchBinding = browserRun(async (_input, init) => {
      signals.push(init?.signal as AbortSignal);
      return new Response(null, { status: 200 });
    });
    const currentSession = sessionFor();
    const { launcher } = launcherFor([currentSession], [], async (binding) => {
      await binding.fetch('https://browser-control.example/acquire');
      await binding.fetch('https://browser-control.example/connect');
    });

    await createBrowserSessionRenderedPagePort(fetchBinding, launcher).render(TARGET_URL);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
  });

  it.each([
    ['acquire', 1],
    ['connect', 2],
  ] as const)(
    'does not reacquire after a hanging browser-control %s timeout',
    async (_name, hangAt) => {
      vi.useFakeTimers();
      let fetchCount = 0;
      const hangingSignals: AbortSignal[] = [];
      const fetchBinding = browserRun((_input, init) => {
        fetchCount += 1;
        if (fetchCount !== hangAt) {
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        const signal = init?.signal as AbortSignal;
        hangingSignals.push(signal);
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('private control detail')), {
            once: true,
          });
        });
      });
      const currentSession = sessionFor();
      const { launch, launcher } = launcherFor([currentSession], [], async (binding) => {
        await binding.fetch('https://browser-control.example/acquire');
        await binding.fetch('https://browser-control.example/connect');
      });
      const rendering = createBrowserSessionRenderedPagePort(fetchBinding, launcher).render(
        TARGET_URL,
      );
      const outcome = rendering.then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error }),
      );

      await vi.advanceTimersByTimeAsync(4_000);
      const { error } = await outcome;

      expect(error).toMatchObject({ message: 'BROWSER_SESSION_LAUNCH_TIMEOUT' });
      expect((error as Error).message).not.toContain('private control detail');
      expect(hangingSignals).toHaveLength(1);
      expect(hangingSignals[0]!.aborted).toBe(true);
      expect(fetchCount).toBe(hangAt);
      expect(launch).toHaveBeenCalledTimes(1);
      expect(currentSession.createBrowserContext).not.toHaveBeenCalled();
    },
  );
});

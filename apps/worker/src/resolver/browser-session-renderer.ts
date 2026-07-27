import puppeteer, { type BrowserWorker, TimeoutError } from '@cloudflare/puppeteer';
import { decodeExactRecord } from '@threads-downloader/contracts/strict-json';

import { parseCdnUrl, UpstreamPolicyError } from '../security/upstream-policy.js';
import type { RenderedThreadsPagePort } from './rendered-threads-media.js';

const BROWSER_CONTROL_REQUEST_TIMEOUT_MS = 4_000;
const NAVIGATION_TIMEOUT_MS = 4_000;
const READINESS_TIMEOUT_MS = 8_000;
const READINESS_POLL_MS = 500;
const MINIMUM_OBSERVATION_MS = 5_000;
const STABILITY_WAIT_MS = 3_000;
const BROWSER_LAUNCH_TIMEOUT_MS = 8_000;
const CONTEXT_ACTIVE_TIMEOUT_MS = 20_000;
const CONTEXT_CLOSE_TIMEOUT_MS = 4_000;
const SESSION_CLOSE_TIMEOUT_MS = 4_000;
const LATE_LAUNCH_WAIT_TIMEOUT_MS = 14_000;
const LATE_CONTEXT_WAIT_TIMEOUT_MS = 14_000;
const BROWSER_KEEP_ALIVE_MS = 10_000;
const MAX_BROWSER_LAUNCH_ATTEMPTS = 2;
const MAX_CONTEXT_ATTEMPTS = 2;
const MAX_IDENTITY_RESULTS = 1;
const MAX_MEDIA_RESULTS = 16;
const MAX_VALUE_LENGTH = 4_096;
const LATE_CONTEXT_CLEANUP_BUDGET_MS = LATE_CONTEXT_WAIT_TIMEOUT_MS + CONTEXT_CLOSE_TIMEOUT_MS;

export const RENDERED_BROWSER_SESSION_BUDGET_MS =
  MAX_BROWSER_LAUNCH_ATTEMPTS * BROWSER_LAUNCH_TIMEOUT_MS +
  MAX_CONTEXT_ATTEMPTS * (CONTEXT_ACTIVE_TIMEOUT_MS + CONTEXT_CLOSE_TIMEOUT_MS) +
  SESSION_CLOSE_TIMEOUT_MS;

export const RENDERED_BROWSER_SESSION_CLEANUP_HORIZON_MS =
  MAX_BROWSER_LAUNCH_ATTEMPTS * BROWSER_LAUNCH_TIMEOUT_MS +
  (MAX_CONTEXT_ATTEMPTS - 1) * (CONTEXT_ACTIVE_TIMEOUT_MS + CONTEXT_CLOSE_TIMEOUT_MS) +
  CONTEXT_ACTIVE_TIMEOUT_MS +
  LATE_CONTEXT_CLEANUP_BUDGET_MS;

export const RENDERED_ALLOWED_REQUEST_PATTERNS = [
  String.raw`^https:\/\/www\.threads\.com\/`,
  String.raw`^https:\/\/(?:[a-z0-9-]+\.)*cdninstagram\.com\/`,
  String.raw`^https:\/\/instagram\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.fna\.fbcdn\.net\/`,
] as const;

const ALLOWED_REQUEST_PATTERNS = RENDERED_ALLOWED_REQUEST_PATTERNS.map(
  (source) => new RegExp(source, 'u'),
);
const CREDENTIAL_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'referer',
  'referrer',
]);

const PAGE_SNAPSHOT_FUNCTION = `() => {
  const bounded = (value) =>
    typeof value === 'string' ? value.slice(0, ${String(MAX_VALUE_LENGTH + 1)}) : '';
  const attributes = (selector, attribute, maximum) =>
    Array.from(document.querySelectorAll(selector))
      .slice(0, maximum + 1)
      .map((element) => bounded(element.getAttribute(attribute)));
  const candidateSources = [];
  const candidateUrls = [];
  const appendCandidate = (source, value) => {
    const result = bounded(value);
    if (result.trim().length > 0 && candidateUrls.length <= ${String(MAX_MEDIA_RESULTS)}) {
      candidateSources.push(source);
      candidateUrls.push(result);
    }
  };
  for (const element of Array.from(document.querySelectorAll('video[src], video source[src]'))) {
    const video = element.tagName === 'VIDEO';
    const literal = bounded(element.getAttribute('src'));
    appendCandidate(video ? 'rendered-video' : 'rendered-source', literal);
    const current = video ? bounded(element.currentSrc) : '';
    if (current.trim().length > 0 && current !== literal) {
      appendCandidate('rendered-video', current);
    }
    if (candidateUrls.length > ${String(MAX_MEDIA_RESULTS)}) {
      break;
    }
  }
  return {
    canonicalUrls: attributes('link[rel="canonical"]', 'href', ${String(MAX_IDENTITY_RESULTS)}),
    openGraphUrls: attributes('meta[property="og:url"]', 'content', ${String(MAX_IDENTITY_RESULTS)}),
    candidateSources,
    candidateUrls,
  };
}`;

const PAGE_SNAPSHOT_EXPRESSION = `(${PAGE_SNAPSHOT_FUNCTION})()`;

function pageReadyExpression(): string {
  const stateKey = `__threads_downloader_readiness_${crypto.randomUUID()}`;
  return `(() => {
    const snapshot = ${PAGE_SNAPSHOT_FUNCTION};
    const value = snapshot();
    const now = performance.now();
    const stateKey = ${JSON.stringify(stateKey)};
    const stored = globalThis[stateKey];
    const previous =
      stored !== null &&
      typeof stored === 'object' &&
      Number.isFinite(stored.startedAt) &&
      stored.startedAt <= now
        ? stored
        : { startedAt: now, candidateKey: null, stableSince: null };
    const identityTerminallyInvalid =
      value.canonicalUrls.length > 0 &&
      value.openGraphUrls.length > 0 &&
      (value.canonicalUrls.length !== 1 ||
        value.openGraphUrls.length !== 1 ||
        value.canonicalUrls[0].length === 0 ||
        value.openGraphUrls[0].length === 0 ||
        value.canonicalUrls[0] !== value.openGraphUrls[0]);
    if (identityTerminallyInvalid) {
      return true;
    }
    const ready =
      value.candidateUrls.length > 0 &&
      value.candidateSources.length === value.candidateUrls.length;
    if (!ready) {
      globalThis[stateKey] = {
        startedAt: previous.startedAt,
        candidateKey: null,
        stableSince: null,
      };
      return false;
    }
    const candidateKey = JSON.stringify([value.candidateSources, value.candidateUrls]);
    const stableSince =
      previous.candidateKey === candidateKey &&
      Number.isFinite(previous.stableSince) &&
      previous.stableSince <= now
        ? previous.stableSince
        : now;
    globalThis[stateKey] = { startedAt: previous.startedAt, candidateKey, stableSince };
    return (
      now - previous.startedAt >= ${String(MINIMUM_OBSERVATION_MS)} &&
      now - stableSince >= ${String(STABILITY_WAIT_MS)}
    );
  })()`;
}

interface BrowserSessionRequest {
  abort(errorCode?: 'blockedbyclient'): Promise<void>;
  continue(overrides?: { readonly headers?: Record<string, string> }): Promise<void>;
  headers(): Record<string, string>;
  isInterceptResolutionHandled(): boolean;
  url(): string;
}

interface BrowserSessionResponse {
  status(): number;
}

interface BrowserSessionHandle {
  dispose(): Promise<void>;
}

export interface BrowserSessionPage {
  evaluate(expression: string): Promise<unknown>;
  goto(
    url: string,
    options: { readonly timeout: number; readonly waitUntil: 'domcontentloaded' },
  ): Promise<BrowserSessionResponse | null>;
  on(event: 'request', handler: (request: BrowserSessionRequest) => Promise<void>): unknown;
  setJavaScriptEnabled(enabled: boolean): Promise<void>;
  setRequestInterception(enabled: boolean): Promise<void>;
  setViewport(viewport: { readonly height: number; readonly width: number }): Promise<void>;
  waitForFunction(
    expression: string,
    options: { readonly polling: number; readonly timeout: number },
  ): Promise<BrowserSessionHandle>;
}

export interface BrowserSessionContext {
  close(): Promise<void>;
  newPage(): Promise<BrowserSessionPage>;
}

export interface BrowserSession {
  close(): Promise<void>;
  createBrowserContext(): Promise<BrowserSessionContext>;
  disconnect(): Promise<void>;
}

export interface BrowserSessionLauncher {
  launch(binding: BrowserWorker, options: { readonly keep_alive: 10_000 }): Promise<BrowserSession>;
}

const DEFAULT_LAUNCHER: BrowserSessionLauncher = {
  launch(binding, options) {
    return puppeteer.launch(binding, options);
  },
};

export type BrowserSessionCleanupScheduler = (cleanup: Promise<void>) => void;

const DEFAULT_CLEANUP_SCHEDULER: BrowserSessionCleanupScheduler = (cleanup) => {
  observe(cleanup);
};
const BROWSER_LAUNCH_OPTIONS = { keep_alive: BROWSER_KEEP_ALIVE_MS } as const;

class BrowserSessionReadinessTimeoutError extends Error {
  constructor() {
    super('BROWSER_SESSION_READINESS_TIMEOUT');
    this.name = 'BrowserSessionReadinessTimeoutError';
  }
}

class BrowserSessionLaunchTimeoutError extends Error {
  constructor() {
    super('BROWSER_SESSION_LAUNCH_TIMEOUT');
    this.name = 'BrowserSessionLaunchTimeoutError';
  }
}

class BrowserSessionContextTimeoutError extends Error {
  constructor() {
    super('BROWSER_SESSION_CONTEXT_TIMEOUT');
    this.name = 'BrowserSessionContextTimeoutError';
  }
}

class BrowserSessionContextCloseTimeoutError extends Error {
  constructor() {
    super('BROWSER_SESSION_CONTEXT_CLOSE_TIMEOUT');
    this.name = 'BrowserSessionContextCloseTimeoutError';
  }
}

class BrowserSessionCloseTimeoutError extends Error {
  constructor() {
    super('BROWSER_SESSION_CLOSE_TIMEOUT');
    this.name = 'BrowserSessionCloseTimeoutError';
  }
}

function observe(promise: Promise<unknown>): void {
  void promise.catch(() => undefined);
}

function settleWithin<T>(
  promise: Promise<T>,
  milliseconds: number,
  timeoutError: Error,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(timeoutError);
      }
    }, milliseconds);
    void promise.then(
      (value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          resolve(value);
        }
      },
      (error: unknown) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(error);
        }
      },
    );
  });
}

function browserBindingWithTimeout(binding: BrowserRun): BrowserWorker {
  return {
    async fetch(input, init) {
      const controller = new AbortController();
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, BROWSER_CONTROL_REQUEST_TIMEOUT_MS);
      try {
        const response = await binding.fetch(input, { ...init, signal: controller.signal });
        if (timedOut) {
          throw new BrowserSessionLaunchTimeoutError();
        }
        return response;
      } catch (error: unknown) {
        if (timedOut) {
          throw new BrowserSessionLaunchTimeoutError();
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

function allowedRequest(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    url.port === '' &&
    ALLOWED_REQUEST_PATTERNS.some((pattern) => pattern.test(rawUrl))
  );
}

function credentialFreeHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !CREDENTIAL_HEADERS.has(name.toLowerCase())),
  );
}

async function interceptRequest(request: BrowserSessionRequest): Promise<void> {
  let rawUrl: string;
  try {
    if (request.isInterceptResolutionHandled()) {
      return;
    }
    rawUrl = request.url();
  } catch {
    return;
  }
  if (rawUrl.startsWith('data:')) {
    return;
  }
  let safe: boolean;
  let headers: Record<string, string> = {};
  try {
    safe = allowedRequest(rawUrl);
    if (safe) {
      headers = credentialFreeHeaders(request.headers());
    }
  } catch {
    safe = false;
  }
  try {
    if (request.isInterceptResolutionHandled()) {
      return;
    }
    if (safe) {
      await request.continue({ headers });
      return;
    }
    await request.abort('blockedbyclient');
  } catch {
    // Navigation/readiness owns the safe failure; the event callback cannot expose details.
  }
}

interface BrowserContextAttemptControl {
  cancelled: boolean;
  context?: BrowserSessionContext;
  contextPromise?: Promise<BrowserSessionContext>;
  hasValue: boolean;
  value?: unknown;
}

interface ContextAttemptResult {
  readonly reusable: boolean;
  readonly value: unknown;
}

interface DecodedBrowserSnapshot {
  readonly candidateSources: readonly ('rendered-source' | 'rendered-video')[];
  readonly candidateUrls: readonly string[];
  readonly identity: string;
}

interface SnapshotAccumulator {
  readonly candidateKeys: Set<string>;
  readonly candidateSources: ('rendered-source' | 'rendered-video')[];
  readonly candidateUrls: string[];
  identity?: string;
}

interface ConnectedRenderResult {
  readonly value: unknown;
}

function assertContextActive(control: BrowserContextAttemptControl): void {
  if (control.cancelled) {
    throw new BrowserSessionContextTimeoutError();
  }
}

function disconnectSession(session: BrowserSession): void {
  try {
    observe(session.disconnect());
  } catch {
    // Disconnect is the final synchronous transport fallback after close fails or times out.
  }
}

async function closeSession(session: BrowserSession): Promise<void> {
  let close: Promise<void>;
  try {
    close = session.close();
  } catch (error: unknown) {
    disconnectSession(session);
    throw error;
  }
  try {
    await settleWithin(close, SESSION_CLOSE_TIMEOUT_MS, new BrowserSessionCloseTimeoutError());
  } catch (error: unknown) {
    disconnectSession(session);
    throw error;
  }
}

async function closeContext(context: BrowserSessionContext): Promise<void> {
  const close = context.close();
  await settleWithin(close, CONTEXT_CLOSE_TIMEOUT_MS, new BrowserSessionContextCloseTimeoutError());
}

function scheduleCleanup(scheduler: BrowserSessionCleanupScheduler, cleanup: Promise<void>): void {
  const safeCleanup = cleanup.catch(() => undefined);
  try {
    scheduler(safeCleanup);
  } catch {
    observe(safeCleanup);
  }
}

async function closeLateLaunch(launch: Promise<BrowserSession>): Promise<void> {
  let session: BrowserSession;
  try {
    session = await settleWithin(
      launch,
      LATE_LAUNCH_WAIT_TIMEOUT_MS,
      new BrowserSessionLaunchTimeoutError(),
    );
  } catch {
    return;
  }
  try {
    await closeSession(session);
  } catch {
    // The bounded close path already disconnected the transport when necessary.
  }
}

async function closeLateContext(contextPromise: Promise<BrowserSessionContext>): Promise<void> {
  let context: BrowserSessionContext;
  try {
    context = await settleWithin(
      contextPromise,
      LATE_CONTEXT_WAIT_TIMEOUT_MS,
      new BrowserSessionContextTimeoutError(),
    );
  } catch {
    return;
  }
  try {
    await closeContext(context);
  } catch {
    // Browser disconnect is the foreground fallback for a late context.
  }
}

function decodeStringArray(
  value: unknown,
  maximumItems: number,
  maximumLength: number,
): readonly string[] | null {
  if (!Array.isArray(value) || value.length > maximumItems) {
    return null;
  }
  const decoded: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.length > maximumLength) {
      return null;
    }
    decoded.push(item);
  }
  return decoded;
}

function renderedIdentityValues(renderUrl: string): readonly string[] {
  let parsed: URL;
  try {
    parsed = new URL(renderUrl);
  } catch {
    return [];
  }
  const match = /^\/@[^/]+\/post\/([^/]+)\/media$/u.exec(parsed.pathname);
  if (
    parsed.origin !== 'https://www.threads.com' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    match === null
  ) {
    return [];
  }
  return [
    `${parsed.origin}${parsed.pathname.slice(0, -'/media'.length)}`,
    `${parsed.origin}/@/post/${match[1]!}`,
  ];
}

function decodeBrowserSnapshot(value: unknown, renderUrl: string): DecodedBrowserSnapshot | null {
  const envelope = decodeExactRecord(value, [
    'canonicalUrls',
    'openGraphUrls',
    'candidateSources',
    'candidateUrls',
  ]);
  if (envelope === null) {
    return null;
  }
  const canonicalUrls = decodeStringArray(
    envelope['canonicalUrls'],
    MAX_IDENTITY_RESULTS,
    MAX_VALUE_LENGTH,
  );
  const openGraphUrls = decodeStringArray(
    envelope['openGraphUrls'],
    MAX_IDENTITY_RESULTS,
    MAX_VALUE_LENGTH,
  );
  const candidateSources = decodeStringArray(
    envelope['candidateSources'],
    MAX_MEDIA_RESULTS,
    'rendered-source'.length,
  );
  const candidateUrls = decodeStringArray(
    envelope['candidateUrls'],
    MAX_MEDIA_RESULTS,
    MAX_VALUE_LENGTH,
  );
  const identity = canonicalUrls?.length === 1 ? canonicalUrls[0] : undefined;
  if (
    identity === undefined ||
    identity.length === 0 ||
    openGraphUrls?.length !== 1 ||
    openGraphUrls[0] !== identity ||
    !renderedIdentityValues(renderUrl).includes(identity) ||
    candidateSources === null ||
    candidateUrls === null ||
    candidateSources.length !== candidateUrls.length ||
    candidateSources.some((source) => source !== 'rendered-source' && source !== 'rendered-video')
  ) {
    return null;
  }
  return {
    identity,
    candidateSources: candidateSources as readonly ('rendered-source' | 'rendered-video')[],
    candidateUrls,
  };
}

function appendSnapshot(accumulator: SnapshotAccumulator, snapshot: DecodedBrowserSnapshot): void {
  accumulator.identity ??= snapshot.identity;
  for (let index = 0; index < snapshot.candidateUrls.length; index += 1) {
    let canonicalUrl: string;
    try {
      canonicalUrl = parseCdnUrl(snapshot.candidateUrls[index]!.trim()).url.href;
    } catch (error: unknown) {
      if (error instanceof UpstreamPolicyError && error.code === 'CDN_URL_INVALID') {
        continue;
      }
      throw error;
    }
    if (accumulator.candidateKeys.has(canonicalUrl)) {
      continue;
    }
    if (accumulator.candidateUrls.length >= MAX_MEDIA_RESULTS) {
      return;
    }
    accumulator.candidateKeys.add(canonicalUrl);
    accumulator.candidateSources.push(snapshot.candidateSources[index]!);
    accumulator.candidateUrls.push(canonicalUrl);
  }
}

function accumulatedSnapshot(accumulator: SnapshotAccumulator): unknown {
  const identity = accumulator.identity;
  if (identity === undefined) {
    throw new BrowserSessionReadinessTimeoutError();
  }
  return {
    canonicalUrls: [identity],
    openGraphUrls: [identity],
    candidateSources: [...accumulator.candidateSources],
    candidateUrls: [...accumulator.candidateUrls],
  };
}

function accumulatedCandidateResult(
  accumulator: SnapshotAccumulator,
): ConnectedRenderResult | null {
  return accumulator.candidateUrls.length > 0 ? { value: accumulatedSnapshot(accumulator) } : null;
}

async function renderContextWork(
  session: BrowserSession,
  url: string,
  control: BrowserContextAttemptControl,
): Promise<unknown> {
  const contextPromise = session.createBrowserContext();
  control.contextPromise = contextPromise;
  const context = await contextPromise;
  control.context = context;
  assertContextActive(control);
  const page = await context.newPage();
  assertContextActive(control);
  await page.setJavaScriptEnabled(true);
  assertContextActive(control);
  await page.setViewport({ width: 1_920, height: 1_080 });
  assertContextActive(control);
  page.on('request', interceptRequest);
  await page.setRequestInterception(true);
  assertContextActive(control);
  const response = await page.goto(url, {
    timeout: NAVIGATION_TIMEOUT_MS,
    waitUntil: 'domcontentloaded',
  });
  assertContextActive(control);
  if (response === null || response.status() !== 200) {
    throw new Error('BROWSER_SESSION_NAVIGATION_INVALID');
  }
  let readiness: BrowserSessionHandle;
  try {
    readiness = await page.waitForFunction(pageReadyExpression(), {
      polling: READINESS_POLL_MS,
      timeout: READINESS_TIMEOUT_MS,
    });
  } catch (error: unknown) {
    if (error instanceof TimeoutError) {
      throw new BrowserSessionReadinessTimeoutError();
    }
    throw error;
  }
  assertContextActive(control);
  try {
    const result = await page.evaluate(PAGE_SNAPSHOT_EXPRESSION);
    control.hasValue = true;
    control.value = result;
    assertContextActive(control);
    return result;
  } finally {
    if (!control.cancelled) {
      await readiness.dispose();
    }
  }
}

async function renderContextAttempt(
  session: BrowserSession,
  cleanupScheduler: BrowserSessionCleanupScheduler,
  url: string,
): Promise<ContextAttemptResult> {
  const control: BrowserContextAttemptControl = { cancelled: false, hasValue: false };
  const work = renderContextWork(session, url, control);
  let result:
    | { readonly ok: true; readonly value: unknown }
    | { readonly error: unknown; readonly ok: false };
  try {
    result = {
      ok: true,
      value: await settleWithin(
        work,
        CONTEXT_ACTIVE_TIMEOUT_MS,
        new BrowserSessionContextTimeoutError(),
      ),
    };
  } catch (error: unknown) {
    result = { error, ok: false };
  }
  control.cancelled = true;

  const activeTimedOut =
    result.ok === false && result.error instanceof BrowserSessionContextTimeoutError;
  if (activeTimedOut) {
    scheduleCleanup(
      cleanupScheduler,
      settleWithin(
        work.then(() => undefined),
        LATE_CONTEXT_CLEANUP_BUDGET_MS,
        new BrowserSessionContextTimeoutError(),
      ),
    );
  }

  let closeError: unknown;
  if (control.context !== undefined) {
    try {
      await closeContext(control.context);
    } catch (error: unknown) {
      closeError = error;
    }
  } else if (activeTimedOut && control.contextPromise !== undefined) {
    scheduleCleanup(cleanupScheduler, closeLateContext(control.contextPromise));
  }

  const cleanupCompromised =
    activeTimedOut || closeError !== undefined || (result.ok === false && control.hasValue);
  if (cleanupCompromised) {
    disconnectSession(session);
  }
  if (result.ok) {
    return { value: result.value, reusable: !cleanupCompromised };
  }
  if (control.hasValue) {
    return { value: control.value, reusable: false };
  }
  if (closeError !== undefined) {
    throw closeError;
  }
  throw result.error;
}

async function launchSessionAttempt(
  binding: BrowserRun,
  launcher: BrowserSessionLauncher,
  cleanupScheduler: BrowserSessionCleanupScheduler,
): Promise<BrowserSession> {
  const launch = launcher.launch(browserBindingWithTimeout(binding), BROWSER_LAUNCH_OPTIONS);
  try {
    return await settleWithin(
      launch,
      BROWSER_LAUNCH_TIMEOUT_MS,
      new BrowserSessionLaunchTimeoutError(),
    );
  } catch (error: unknown) {
    if (error instanceof BrowserSessionLaunchTimeoutError) {
      scheduleCleanup(cleanupScheduler, closeLateLaunch(launch));
    }
    throw error;
  }
}

async function acquireSession(
  binding: BrowserRun,
  launcher: BrowserSessionLauncher,
  cleanupScheduler: BrowserSessionCleanupScheduler,
): Promise<BrowserSession> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_BROWSER_LAUNCH_ATTEMPTS; attempt += 1) {
    try {
      return await launchSessionAttempt(binding, launcher, cleanupScheduler);
    } catch (error: unknown) {
      lastError = error;
      if (error instanceof BrowserSessionLaunchTimeoutError) {
        throw error;
      }
    }
  }
  throw lastError;
}

async function renderConnectedSession(
  session: BrowserSession,
  cleanupScheduler: BrowserSessionCleanupScheduler,
  url: string,
): Promise<ConnectedRenderResult> {
  const accumulator: SnapshotAccumulator = {
    candidateKeys: new Set(),
    candidateSources: [],
    candidateUrls: [],
  };
  let lastReadinessError: BrowserSessionReadinessTimeoutError | undefined;

  for (let attempt = 0; attempt < MAX_CONTEXT_ATTEMPTS; attempt += 1) {
    let contextResult: ContextAttemptResult;
    try {
      contextResult = await renderContextAttempt(session, cleanupScheduler, url);
    } catch (error: unknown) {
      if (error instanceof BrowserSessionReadinessTimeoutError) {
        lastReadinessError = error;
        continue;
      }
      const recovered = accumulatedCandidateResult(accumulator);
      if (recovered !== null) {
        return recovered;
      }
      throw error;
    }

    const snapshot = decodeBrowserSnapshot(contextResult.value, url);
    if (snapshot === null) {
      return accumulatedCandidateResult(accumulator) ?? { value: contextResult.value };
    }
    appendSnapshot(accumulator, snapshot);
    if (contextResult.reusable === false) {
      return { value: accumulatedSnapshot(accumulator) };
    }
  }

  if (accumulator.identity !== undefined) {
    return { value: accumulatedSnapshot(accumulator) };
  }
  throw lastReadinessError ?? new BrowserSessionReadinessTimeoutError();
}

export function createBrowserSessionRenderedPagePort(
  binding: BrowserRun,
  launcher: BrowserSessionLauncher = DEFAULT_LAUNCHER,
  cleanupScheduler: BrowserSessionCleanupScheduler = DEFAULT_CLEANUP_SCHEDULER,
): RenderedThreadsPagePort {
  return {
    async render(url) {
      const session = await acquireSession(binding, launcher, cleanupScheduler);
      let result:
        | { readonly ok: true; readonly value: ConnectedRenderResult }
        | { readonly error: unknown; readonly ok: false };
      try {
        result = {
          ok: true,
          value: await renderConnectedSession(session, cleanupScheduler, url),
        };
      } catch (error: unknown) {
        result = { error, ok: false };
      }
      try {
        await closeSession(session);
      } catch {
        // Disconnect already ran; the primary render outcome remains authoritative.
      }
      if (result.ok) {
        return result.value.value;
      }
      throw result.error;
    },
  };
}

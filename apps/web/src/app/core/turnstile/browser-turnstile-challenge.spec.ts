import { TestBed } from '@angular/core/testing';

import {
  BrowserTurnstileChallenge,
  TURNSTILE_ACTION,
  TURNSTILE_CHALLENGE,
  TURNSTILE_READY_TIMEOUT_MS,
  TURNSTILE_SCRIPT_TIMEOUT_MS,
  TURNSTILE_SCRIPT_URL,
  type TurnstileWidgetHandle,
} from './browser-turnstile-challenge.js';

interface CapturedRenderOptions {
  readonly sitekey: string;
  readonly action: string;
  readonly callback: (token: unknown) => void;
  readonly 'error-callback': () => void;
  readonly 'expired-callback': () => void;
  readonly 'timeout-callback': () => void;
  readonly 'response-field': boolean;
  readonly retry: string;
  readonly 'refresh-expired': string;
}

function turnstileScripts(): HTMLScriptElement[] {
  return [...document.scripts].filter(
    (script) => script.getAttribute('src') === TURNSTILE_SCRIPT_URL,
  );
}

function onlyScript(): HTMLScriptElement {
  const scripts = turnstileScripts();
  expect(scripts).toHaveLength(1);
  const script = scripts[0];
  if (script === undefined) {
    throw new Error('Expected one Turnstile script.');
  }
  return script;
}

function attachedContainer(): HTMLElement {
  const container = document.createElement('div');
  document.body.append(container);
  return container;
}

function fakeBrowserApi() {
  let rendered = 0;
  const readyCallbacks: Array<() => void> = [];
  const ready = vi.fn((callback: () => void) => {
    readyCallbacks.push(callback);
  });
  const render = vi.fn<(container: HTMLElement, options: unknown) => string>(() => {
    rendered += 1;
    return `widget-${rendered}`;
  });
  const reset = vi.fn<(widgetId: string) => void>();
  const remove = vi.fn<(widgetId: string) => void>();
  const api = { ready, render, reset, remove };
  return { api, readyCallbacks, ready, render, reset, remove };
}

function invokeReady(callbacks: Array<() => void>): void {
  const callback = callbacks.shift();
  expect(callback).toBeDefined();
  if (callback === undefined) {
    throw new Error('Expected a Turnstile ready callback.');
  }
  callback();
}

function renderOptions(render: ReturnType<typeof fakeBrowserApi>['render']): CapturedRenderOptions {
  const options = render.mock.calls[0]?.[1];
  expect(options).toBeDefined();
  if (options === undefined) {
    throw new Error('Expected Turnstile render options.');
  }
  return options as CapturedRenderOptions;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function loadAndRender(
  challenge: BrowserTurnstileChallenge,
  siteKey = 'public-site-key',
): Promise<{
  readonly handle: TurnstileWidgetHandle;
  readonly fake: ReturnType<typeof fakeBrowserApi>;
  readonly options: CapturedRenderOptions;
}> {
  const handle = challenge.mount({ siteKey, container: attachedContainer() });
  const fake = fakeBrowserApi();
  Reflect.set(window, 'turnstile', fake.api);
  onlyScript().dispatchEvent(new Event('load'));
  await flushPromises();
  invokeReady(fake.readyCallbacks);
  return { handle, fake, options: renderOptions(fake.render) };
}

describe('BrowserTurnstileChallenge', () => {
  let challenge: BrowserTurnstileChallenge;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    challenge = TestBed.inject(BrowserTurnstileChallenge);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, 'turnstile');
    for (const script of turnstileScripts()) {
      script.remove();
    }
    document.body.replaceChildren();
  });

  it('loads the exact explicit script once and exposes the port through DI', async () => {
    const first = challenge.mount({ siteKey: 'public-site-key', container: attachedContainer() });
    const second = challenge.mount({ siteKey: 'public-site-key', container: attachedContainer() });
    const script = onlyScript();

    expect(TestBed.inject(TURNSTILE_CHALLENGE)).toBe(challenge);
    expect(first.status()).toBe('loading');
    expect(second.status()).toBe('loading');
    expect(script.getAttribute('src')).toBe(TURNSTILE_SCRIPT_URL);
    expect(script.defer).toBe(true);
    expect(script.async).toBe(false);
    expect(script.hasAttribute('integrity')).toBe(false);
    expect(script.hasAttribute('crossorigin')).toBe(false);

    const fake = fakeBrowserApi();
    Reflect.set(window, 'turnstile', fake.api);
    script.dispatchEvent(new Event('load'));
    await flushPromises();
    expect(fake.readyCallbacks).toHaveLength(2);
    invokeReady(fake.readyCallbacks);
    invokeReady(fake.readyCallbacks);
    expect(fake.render).toHaveBeenCalledTimes(2);
  });

  it('reuses an existing exact script instead of inserting a duplicate', async () => {
    const existing = document.createElement('script');
    existing.src = TURNSTILE_SCRIPT_URL;
    existing.defer = true;
    document.head.append(existing);

    const handle = challenge.mount({ siteKey: 'public-site-key', container: attachedContainer() });
    const fake = fakeBrowserApi();
    Reflect.set(window, 'turnstile', fake.api);
    existing.dispatchEvent(new Event('load'));
    await flushPromises();
    invokeReady(fake.readyCallbacks);

    expect(onlyScript()).toBe(existing);
    expect(fake.render).toHaveBeenCalledTimes(1);
    expect(handle.status()).toBe('ready');
  });

  it('renders with the fixed policy, keeps the token in state, and resets or removes by ID', async () => {
    const { handle, fake, options } = await loadAndRender(challenge);

    expect(fake.ready).toHaveBeenCalledTimes(1);
    expect(fake.render.mock.calls[0]?.[0]).toBeInstanceOf(HTMLElement);
    expect(options).toMatchObject({
      sitekey: 'public-site-key',
      action: TURNSTILE_ACTION,
      'response-field': false,
      retry: 'auto',
      'refresh-expired': 'auto',
    });
    expect(TURNSTILE_ACTION).toBe('resolve');
    expect(handle.status()).toBe('ready');
    expect(handle.token()).toBeNull();

    options.callback('private-turnstile-token');
    expect(handle.status()).toBe('verified');
    expect(handle.token()).toBe('private-turnstile-token');

    handle.reset();
    expect(fake.reset).toHaveBeenCalledWith('widget-1');
    expect(handle.status()).toBe('ready');
    expect(handle.token()).toBeNull();

    options.callback('replacement-token');
    handle.remove();
    expect(fake.remove).toHaveBeenCalledWith('widget-1');
    expect(handle.status()).toBe('removed');
    expect(handle.token()).toBeNull();

    options.callback('late-token');
    options['error-callback']();
    expect(handle.status()).toBe('removed');
    expect(handle.token()).toBeNull();
  });

  it.each(['error-callback', 'expired-callback', 'timeout-callback'] as const)(
    'clears the token and fails closed for %s',
    async (callbackName) => {
      const { handle, options } = await loadAndRender(challenge);
      options.callback('one-time-token');

      options[callbackName]();

      expect(handle.status()).toBe('error');
      expect(handle.token()).toBeNull();
    },
  );

  it.each([42, '', '   ', 'A'.repeat(2_049)])(
    'fails closed when the browser API supplies an invalid token: %s',
    async (token) => {
      const { handle, options } = await loadAndRender(challenge);

      options.callback(token);

      expect(handle.status()).toBe('error');
      expect(handle.token()).toBeNull();
    },
  );

  it('renders only the validated mount snapshot when caller input changes later', async () => {
    const originalContainer = attachedContainer();
    const command = { siteKey: 'original-site-key', container: originalContainer };
    const handle = challenge.mount(command);
    command.siteKey = 'changed-site-key';
    command.container = attachedContainer();
    const fake = fakeBrowserApi();
    Reflect.set(window, 'turnstile', fake.api);
    onlyScript().dispatchEvent(new Event('load'));
    await flushPromises();
    invokeReady(fake.readyCallbacks);

    expect(fake.render.mock.calls[0]?.[0]).toBe(originalContainer);
    expect(renderOptions(fake.render).sitekey).toBe('original-site-key');
    expect(handle.status()).toBe('ready');
  });

  it('does not render when remove wins the delayed ready callback race', async () => {
    vi.useFakeTimers();
    const handle = challenge.mount({
      siteKey: 'public-site-key',
      container: attachedContainer(),
    });
    const fake = fakeBrowserApi();
    Reflect.set(window, 'turnstile', fake.api);
    onlyScript().dispatchEvent(new Event('load'));
    await flushPromises();

    handle.remove();
    invokeReady(fake.readyCallbacks);
    await vi.advanceTimersByTimeAsync(TURNSTILE_READY_TIMEOUT_MS);

    expect(fake.render).not.toHaveBeenCalled();
    expect(fake.remove).not.toHaveBeenCalled();
    expect(handle.status()).toBe('removed');
    expect(handle.token()).toBeNull();
  });

  it('fails closed when the browser API never invokes its ready callback', async () => {
    vi.useFakeTimers();
    const handle = challenge.mount({
      siteKey: 'public-site-key',
      container: attachedContainer(),
    });
    const fake = fakeBrowserApi();
    Reflect.set(window, 'turnstile', fake.api);
    onlyScript().dispatchEvent(new Event('load'));
    await flushPromises();

    await vi.advanceTimersByTimeAsync(TURNSTILE_READY_TIMEOUT_MS);

    expect(handle.status()).toBe('error');
    expect(handle.token()).toBeNull();
    invokeReady(fake.readyCallbacks);
    expect(fake.render).not.toHaveBeenCalled();
  });

  it('fails closed and permits a clean retry after a script error', async () => {
    const first = challenge.mount({ siteKey: 'public-site-key', container: attachedContainer() });
    onlyScript().dispatchEvent(new Event('error'));
    await flushPromises();

    expect(first.status()).toBe('error');
    expect(first.token()).toBeNull();
    expect(turnstileScripts()).toHaveLength(0);

    const second = challenge.mount({ siteKey: 'public-site-key', container: attachedContainer() });
    expect(second.status()).toBe('loading');
    expect(turnstileScripts()).toHaveLength(1);
    onlyScript().dispatchEvent(new Event('error'));
    await flushPromises();
    expect(second.status()).toBe('error');
  });

  it('fails closed and removes a script that does not load before the timeout', async () => {
    vi.useFakeTimers();
    const handle = challenge.mount({ siteKey: 'public-site-key', container: attachedContainer() });

    await vi.advanceTimersByTimeAsync(TURNSTILE_SCRIPT_TIMEOUT_MS);

    expect(handle.status()).toBe('error');
    expect(handle.token()).toBeNull();
    expect(turnstileScripts()).toHaveLength(0);
  });

  it('fails without loading the script when mount input is unusable', () => {
    const detached = document.createElement('div');
    const emptySiteKey = challenge.mount({ siteKey: '', container: attachedContainer() });
    const unsafeSiteKey = challenge.mount({
      siteKey: 'https://challenges.cloudflare.com/private',
      container: attachedContainer(),
    });
    const oversizedSiteKey = challenge.mount({
      siteKey: 'A'.repeat(129),
      container: attachedContainer(),
    });
    const detachedContainer = challenge.mount({ siteKey: 'public-site-key', container: detached });

    expect(emptySiteKey.status()).toBe('error');
    expect(unsafeSiteKey.status()).toBe('error');
    expect(oversizedSiteKey.status()).toBe('error');
    expect(detachedContainer.status()).toBe('error');
    expect(turnstileScripts()).toHaveLength(0);
  });

  it('keeps state fail closed when reset or remove throws', async () => {
    const { handle, fake, options } = await loadAndRender(challenge);
    options.callback('one-time-token');
    fake.reset.mockImplementationOnce(() => {
      throw new Error('reset failed');
    });

    expect(() => handle.reset()).not.toThrow();
    expect(handle.status()).toBe('error');
    expect(handle.token()).toBeNull();

    fake.remove.mockImplementationOnce(() => {
      throw new Error('remove failed');
    });
    expect(() => handle.remove()).not.toThrow();
    expect(handle.status()).toBe('removed');
    expect(handle.token()).toBeNull();
  });
});

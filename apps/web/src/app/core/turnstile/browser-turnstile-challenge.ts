import { DOCUMENT } from '@angular/common';
import { inject, Injectable, InjectionToken, signal, type Signal } from '@angular/core';

export const TURNSTILE_SCRIPT_URL =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
export const TURNSTILE_SCRIPT_TIMEOUT_MS = 15_000;
export const TURNSTILE_ACTION = 'resolve';

const maximumTokenLength = 2_048;
const safeSiteKey = /^[A-Za-z0-9_-]{1,128}$/u;

export type TurnstileWidgetStatus = 'loading' | 'ready' | 'verified' | 'error' | 'removed';

export interface TurnstileMount {
  readonly siteKey: string;
  readonly container: HTMLElement;
}

export interface TurnstileWidgetHandle {
  readonly status: Signal<TurnstileWidgetStatus>;
  readonly token: Signal<string | null>;
  reset(): void;
  remove(): void;
}

export interface TurnstileChallengePort {
  mount(command: TurnstileMount): TurnstileWidgetHandle;
}

interface TurnstileRenderOptions {
  readonly sitekey: string;
  readonly action: typeof TURNSTILE_ACTION;
  readonly callback: (token: unknown) => void;
  readonly 'error-callback': () => void;
  readonly 'expired-callback': () => void;
  readonly 'timeout-callback': () => void;
  readonly 'response-field': false;
  readonly retry: 'auto';
  readonly 'refresh-expired': 'auto';
  readonly size: 'flexible';
}

interface TurnstileBrowserApi {
  render(container: HTMLElement, options: TurnstileRenderOptions): unknown;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

class TurnstileUnavailableError extends Error {
  constructor() {
    super('TURNSTILE_UNAVAILABLE');
    this.name = 'TurnstileUnavailableError';
  }
}

function isTurnstileBrowserApi(value: unknown): value is TurnstileBrowserApi {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record['render'] === 'function' &&
    typeof record['reset'] === 'function' &&
    typeof record['remove'] === 'function'
  );
}

function browserApi(document: Document): TurnstileBrowserApi | null {
  const view = document.defaultView;
  if (view === null) {
    return null;
  }
  try {
    const candidate: unknown = Reflect.get(view, 'turnstile');
    return isTurnstileBrowserApi(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

@Injectable({ providedIn: 'root' })
class TurnstileScriptLoader {
  private readonly document = inject(DOCUMENT);
  private pending: Promise<TurnstileBrowserApi> | undefined;

  load(): Promise<TurnstileBrowserApi> {
    if (this.pending !== undefined) {
      return this.pending;
    }
    const loaded = browserApi(this.document);
    if (loaded !== null) {
      return Promise.resolve(loaded);
    }

    const existing = this.findScript();
    const script = existing ?? this.createScript();
    const pending = this.waitForScript(script, existing === null);
    this.pending = pending;
    void pending.catch(() => {
      if (this.pending === pending) {
        this.pending = undefined;
      }
    });
    return pending;
  }

  private findScript(): HTMLScriptElement | null {
    for (const script of this.document.scripts) {
      if (script.getAttribute('src') === TURNSTILE_SCRIPT_URL) {
        return script;
      }
    }
    return null;
  }

  private createScript(): HTMLScriptElement {
    const script = this.document.createElement('script');
    script.src = TURNSTILE_SCRIPT_URL;
    script.defer = true;
    script.async = false;
    return script;
  }

  private waitForScript(
    script: HTMLScriptElement,
    shouldAppend: boolean,
  ): Promise<TurnstileBrowserApi> {
    return new Promise((resolve, reject) => {
      let settled = false;

      const cleanup = (): void => {
        script.removeEventListener('load', onLoad);
        script.removeEventListener('error', onError);
        clearTimeout(timeout);
      };
      const fail = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        script.remove();
        reject(new TurnstileUnavailableError());
      };
      const succeed = (api: TurnstileBrowserApi): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(api);
      };
      const onLoad = (): void => {
        const api = browserApi(this.document);
        if (api === null) {
          fail();
          return;
        }
        succeed(api);
      };
      const onError = (): void => {
        fail();
      };

      script.addEventListener('load', onLoad);
      script.addEventListener('error', onError);
      const timeout = setTimeout(fail, TURNSTILE_SCRIPT_TIMEOUT_MS);

      const api = browserApi(this.document);
      if (api !== null) {
        succeed(api);
        return;
      }
      if (shouldAppend) {
        try {
          this.document.head.append(script);
        } catch {
          fail();
        }
      }
    });
  }
}

class BrowserTurnstileWidget implements TurnstileWidgetHandle {
  private readonly statusValue = signal<TurnstileWidgetStatus>('loading');
  private readonly tokenValue = signal<string | null>(null);
  private api: TurnstileBrowserApi | null = null;
  private widgetId: string | null = null;
  private removed = false;

  readonly status = this.statusValue.asReadonly();
  readonly token = this.tokenValue.asReadonly();

  constructor(
    private readonly siteKey: string,
    private readonly container: HTMLElement,
    private readonly document: Document,
  ) {}

  connect(api: TurnstileBrowserApi): void {
    if (this.removed || this.api !== null || this.statusValue() !== 'loading') {
      return;
    }
    this.api = api;
    this.renderIfActive(api);
  }

  unavailable(): void {
    this.failClosed();
  }

  reset(): void {
    this.tokenValue.set(null);
    if (this.removed || this.api === null || this.widgetId === null) {
      return;
    }
    try {
      this.api.reset(this.widgetId);
      this.statusValue.set('ready');
    } catch {
      this.failClosed();
    }
  }

  remove(): void {
    if (this.removed) {
      return;
    }
    this.removed = true;
    this.tokenValue.set(null);
    this.statusValue.set('removed');

    const api = this.api;
    const widgetId = this.widgetId;
    this.api = null;
    this.widgetId = null;
    if (api === null || widgetId === null) {
      return;
    }
    try {
      api.remove(widgetId);
    } catch {
      return;
    }
  }

  private renderIfActive(api: TurnstileBrowserApi): void {
    if (this.removed || this.widgetId !== null || this.statusValue() !== 'loading') {
      return;
    }
    if (this.container.ownerDocument !== this.document || !this.container.isConnected) {
      this.failClosed();
      return;
    }

    try {
      const widgetId = api.render(this.container, {
        sitekey: this.siteKey,
        action: TURNSTILE_ACTION,
        callback: (token) => this.acceptToken(token),
        'error-callback': () => this.failClosed(),
        'expired-callback': () => this.failClosed(),
        'timeout-callback': () => this.failClosed(),
        'response-field': false,
        retry: 'auto',
        'refresh-expired': 'auto',
        size: 'flexible',
      });
      if (typeof widgetId !== 'string' || widgetId.length === 0) {
        this.failClosed();
        return;
      }
      this.widgetId = widgetId;
      if (this.statusValue() === 'loading') {
        this.statusValue.set('ready');
      }
    } catch {
      this.failClosed();
    }
  }

  private acceptToken(token: unknown): void {
    if (this.removed) {
      return;
    }
    if (typeof token !== 'string' || token.trim() === '' || token.length > maximumTokenLength) {
      this.failClosed();
      return;
    }
    this.tokenValue.set(token);
    this.statusValue.set('verified');
  }

  private failClosed(): void {
    if (this.removed) {
      return;
    }
    this.tokenValue.set(null);
    this.statusValue.set('error');
  }
}

@Injectable({ providedIn: 'root' })
export class BrowserTurnstileChallenge implements TurnstileChallengePort {
  private readonly document = inject(DOCUMENT);
  private readonly loader = inject(TurnstileScriptLoader);

  mount(command: TurnstileMount): TurnstileWidgetHandle {
    const siteKey = command.siteKey;
    const container = command.container;
    const widget = new BrowserTurnstileWidget(siteKey, container, this.document);
    if (
      !safeSiteKey.test(siteKey) ||
      container.ownerDocument !== this.document ||
      !container.isConnected
    ) {
      widget.unavailable();
      return widget;
    }

    void this.loader.load().then(
      (api) => widget.connect(api),
      () => widget.unavailable(),
    );
    return widget;
  }
}

export const TURNSTILE_CHALLENGE = new InjectionToken<TurnstileChallengePort>(
  'TURNSTILE_CHALLENGE',
  {
    providedIn: 'root',
    factory: () => inject(BrowserTurnstileChallenge),
  },
);

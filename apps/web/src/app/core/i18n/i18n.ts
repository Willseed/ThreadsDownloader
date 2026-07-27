import { DOCUMENT } from '@angular/common';
import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { type RouterStateSnapshot, TitleStrategy } from '@angular/router';
import { type ApiErrorCode } from '@threads-downloader/contracts';

import { zhTW } from './locales/zh-TW.js';

export const SUPPORTED_LOCALES = ['zh-TW'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
export type RouteTitleKey = keyof typeof zhTW.routes;
export const DEFAULT_LOCALE: SupportedLocale = 'zh-TW';
export const MESSAGE_CATALOGS = { 'zh-TW': zhTW } as const;

function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === 'string' && SUPPORTED_LOCALES.some((locale) => locale === value);
}

@Injectable({ providedIn: 'root' })
export class I18nService {
  private readonly document = inject(DOCUMENT);
  private readonly title = inject(Title);
  private readonly meta = inject(Meta);
  private readonly localeValue = signal<SupportedLocale>(DEFAULT_LOCALE);
  private readonly routeTitleKey = signal<RouteTitleKey>('home');

  readonly locale = this.localeValue.asReadonly();
  readonly messages = computed(() => MESSAGE_CATALOGS[this.localeValue()]);

  constructor() {
    effect(() => {
      const messages = this.messages();
      this.document.documentElement.lang = messages.locale.code;
      this.document.documentElement.dir = messages.locale.direction;
      this.title.setTitle(messages.routes[this.routeTitleKey()]);
      this.meta.updateTag({ name: 'description', content: messages.metadata.description });
    });
  }

  setLocale(value: unknown): SupportedLocale {
    const locale = isSupportedLocale(value) ? value : DEFAULT_LOCALE;
    this.localeValue.set(locale);
    return locale;
  }

  setRouteTitle(key: RouteTitleKey): void {
    this.routeTitleKey.set(key);
  }

  apiError(code: ApiErrorCode): string {
    return this.messages().apiErrors[code];
  }
}

@Injectable()
export class LocalizedTitleStrategy extends TitleStrategy {
  private readonly i18n = inject(I18nService);

  override updateTitle(snapshot: RouterStateSnapshot): void {
    let route = snapshot.root;
    while (route.firstChild !== null) {
      route = route.firstChild;
    }
    const key = route.data['titleKey'];
    this.i18n.setRouteTitle(
      typeof key === 'string' && key in this.i18n.messages().routes
        ? (key as RouteTitleKey)
        : 'home',
    );
  }
}

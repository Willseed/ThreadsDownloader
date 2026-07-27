import { TestBed } from '@angular/core/testing';
import { type RouterStateSnapshot } from '@angular/router';
import { API_ERROR_CODES } from '@threads-downloader/contracts';

import {
  DEFAULT_LOCALE,
  I18nService,
  LocalizedTitleStrategy,
  MESSAGE_CATALOGS,
  SUPPORTED_LOCALES,
} from './i18n.js';

function leafPaths(value: unknown, prefix = ''): string[] {
  if (typeof value === 'string' || typeof value === 'function') {
    return [prefix];
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`INVALID_CATALOG_LEAF:${prefix}`);
  }
  return Object.entries(value).flatMap(([key, child]) =>
    leafPaths(child, prefix.length === 0 ? key : `${prefix}.${key}`),
  );
}

describe('I18nService', () => {
  it('keeps every supported locale on the complete non-empty message contract', () => {
    const baselinePaths = leafPaths(MESSAGE_CATALOGS[DEFAULT_LOCALE]).sort();

    expect(baselinePaths.length).toBeGreaterThan(100);
    for (const locale of SUPPORTED_LOCALES) {
      expect(leafPaths(MESSAGE_CATALOGS[locale]).sort()).toEqual(baselinePaths);
      for (const path of baselinePaths) {
        const leaf = path
          .split('.')
          .reduce<unknown>(
            (value, key) => (value as Readonly<Record<string, unknown>>)[key],
            MESSAGE_CATALOGS[locale],
          );
        if (typeof leaf === 'string') {
          expect(leaf.trim(), `${locale}:${path}`).not.toBe('');
        }
      }
    }
  });

  it('switches metadata at runtime and falls back safely', () => {
    const service = TestBed.inject(I18nService);

    expect(service.setLocale('ja')).toBe('ja');
    TestBed.flushEffects();
    expect(document.documentElement.lang).toBe('ja');
    expect(document.title).toBe(MESSAGE_CATALOGS.ja.routes.home);
    expect(document.querySelector('meta[name="description"]')?.getAttribute('content')).toBe(
      MESSAGE_CATALOGS.ja.metadata.description,
    );

    expect(service.setLocale('unsupported')).toBe(DEFAULT_LOCALE);
    TestBed.flushEffects();

    expect(service.locale()).toBe('zh-TW');
    expect(document.documentElement.lang).toBe('zh-TW');
    expect(document.documentElement.dir).toBe('ltr');
    expect(document.title).toBe(MESSAGE_CATALOGS['zh-TW'].routes.home);
    expect(document.querySelector('meta[name="description"]')?.getAttribute('content')).toBe(
      MESSAGE_CATALOGS['zh-TW'].metadata.description,
    );
  });

  it('maps every public API error code to a local message', () => {
    const service = TestBed.inject(I18nService);

    for (const locale of SUPPORTED_LOCALES) {
      service.setLocale(locale);
      expect(API_ERROR_CODES.map((code) => service.apiError(code))).toEqual(
        API_ERROR_CODES.map((code) => MESSAGE_CATALOGS[locale].apiErrors[code]),
      );
    }
  });

  it('updates the current route title from a stable title key', () => {
    TestBed.configureTestingModule({ providers: [LocalizedTitleStrategy] });
    const service = TestBed.inject(I18nService);
    const strategy = TestBed.inject(LocalizedTitleStrategy);

    service.setLocale('ja');

    strategy.updateTitle({
      root: {
        firstChild: { firstChild: null, data: { titleKey: 'privacy' } },
      },
    } as unknown as RouterStateSnapshot);
    TestBed.flushEffects();

    expect(document.title).toBe(MESSAGE_CATALOGS.ja.routes.privacy);
  });
});

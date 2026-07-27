import AxeBuilder from '@axe-core/playwright';
import { type Page } from '@playwright/test';

import { expect, test } from './fixtures/downloader-mock.js';

async function waitForReadyPage(page: Page): Promise<void> {
  await page.goto('/');
  const turnstile = page.locator('.turnstile-container');
  await expect(turnstile.getByRole('status', { name: '安全驗證測試替身' })).toHaveText(
    '安全驗證已完成',
  );
  await expect(page.locator('#challenge-title, .challenge-block')).toHaveCount(0);
}

function cssTimeToMilliseconds(value: string): number {
  if (value.endsWith('ms')) {
    return Number.parseFloat(value);
  }
  if (value.endsWith('s')) {
    return Number.parseFloat(value) * 1_000;
  }
  throw new Error('Unexpected CSS time unit.');
}

test('has no automatically detectable full-page accessibility violations', async ({ page }) => {
  await waitForReadyPage(page);

  const results = await new AxeBuilder({ page }).analyze();
  const violations = results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    targets: violation.nodes.flatMap((node) => node.target),
  }));
  expect(violations).toEqual([]);
});

test('offers visible keyboard focus in a logical entry sequence', async ({ page }) => {
  await waitForReadyPage(page);

  const skipLink = page.getByRole('link', { name: '跳到主要內容' });
  const wordmark = page.getByRole('link', { name: 'Threads Downloader 首頁' });
  const input = page.getByRole('textbox', { name: 'Threads 貼文網址' });
  const tabOrder = [
    skipLink,
    wordmark,
    page.getByRole('link', { name: '開始下載', exact: true }),
    page.getByRole('combobox', { name: '選擇語言' }),
    input,
  ];

  await page.keyboard.press('Tab');
  await expect(tabOrder[0]!).toBeFocused();
  const skipLinkBox = await skipLink.boundingBox();
  expect(skipLinkBox).not.toBeNull();
  expect(skipLinkBox!.y).toBeGreaterThanOrEqual(0);

  for (const target of tabOrder.slice(1)) {
    await page.keyboard.press('Tab');
    await expect(target).toBeFocused();
  }

  const focusStyle = await input.evaluate((element) => {
    const style = getComputedStyle(element);
    return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
  });
  expect(focusStyle.outlineStyle).not.toBe('none');
  expect(Number.parseFloat(focusStyle.outlineWidth)).toBeGreaterThan(0);
});

test('contains focus in an on-demand legal dialog and restores its trigger', async ({ page }) => {
  await waitForReadyPage(page);

  const trigger = page.locator('.site-footer').getByRole('link', { name: /隱私/u });
  await trigger.focus();
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('dialog', { name: '隱私與資料處理說明' });
  const close = dialog.getByRole('button', { name: '關閉', exact: true });
  await expect(dialog).toBeVisible();
  await expect(close).toBeFocused();
  const results = await new AxeBuilder({ page }).include('.legal-modal').analyze();
  expect(results.violations).toEqual([]);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('keeps the primary form operable in the 1280 by 800 initial viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await waitForReadyPage(page);

  const postUrl = page.getByRole('textbox', { name: 'Threads 貼文網址' });
  const submit = page.getByRole('button', { name: '取得影片' });
  const viewport = await page.evaluate(() => ({
    height: window.innerHeight,
    scrollY: window.scrollY,
    width: window.innerWidth,
  }));

  expect(viewport).toEqual({ height: 800, scrollY: 0, width: 1280 });
  for (const control of [postUrl, submit]) {
    await expect(control).toBeVisible();
    await expect(control).toBeEnabled();
    await expect(control).toBeInViewport({ ratio: 1 });
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
  }

  const postUrlBox = await postUrl.boundingBox();
  const turnstileBox = await page.locator('.turnstile-container').boundingBox();
  expect(postUrlBox).not.toBeNull();
  expect(turnstileBox).not.toBeNull();
  expect(Math.round(turnstileBox!.width)).toBe(Math.round(postUrlBox!.width));
  expect(Math.round(turnstileBox!.height)).toBe(65);

  const exampleUrl = 'https://www.threads.com/@research/post/example';
  await postUrl.fill(exampleUrl);
  await expect(postUrl).toHaveValue(exampleUrl);
  await submit.focus();
  await expect(submit).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test('keeps the complete primary flow in the initial 390 by 844 mobile viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await waitForReadyPage(page);

  const postUrl = page.getByRole('textbox', { name: 'Threads 貼文網址' });
  await expect(
    page.getByRole('heading', { level: 1, name: '下載公開 Threads 影片' }),
  ).toBeVisible();
  const primaryFlow = [
    postUrl,
    page.locator('.rights-confirmation'),
    page.locator('.turnstile-container'),
    page.getByRole('button', { name: '取得影片' }),
  ];
  for (const control of primaryFlow) {
    await expect(control).toBeVisible();
    await expect(control).toBeInViewport({ ratio: 1 });
    const controlBox = await control.boundingBox();
    expect(controlBox).not.toBeNull();
    expect(controlBox!.y).toBeGreaterThanOrEqual(0);
    expect(controlBox!.y + controlBox!.height).toBeLessThanOrEqual(844);
  }
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  const box = await postUrl.boundingBox();
  const turnstileBox = await page.locator('.turnstile-container').boundingBox();
  expect(box).not.toBeNull();
  expect(turnstileBox).not.toBeNull();
  expect(Math.round(turnstileBox!.width)).toBe(Math.round(box!.width));
  expect(Math.round(turnstileBox!.height)).toBe(65);
});

test('reflows at 320 CSS pixels with flexible verification and readable reduced motion', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await waitForReadyPage(page);

  const viewport = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(viewport.innerWidth).toBe(320);
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.innerWidth);
  expect(viewport.reducedMotion).toBe(true);

  const turnstile = page.locator('.turnstile-container');
  const turnstileBox = await turnstile.boundingBox();
  expect(turnstileBox).not.toBeNull();
  expect(turnstileBox!.width).toBeGreaterThanOrEqual(300);
  expect(Math.round(turnstileBox!.height)).toBe(65);
  expect(turnstileBox!.x).toBeGreaterThanOrEqual(0);
  expect(turnstileBox!.x + turnstileBox!.width).toBeLessThanOrEqual(viewport.innerWidth);

  const controls = [
    page.getByRole('textbox', { name: 'Threads 貼文網址' }),
    page.locator('.rights-confirmation'),
    page.getByRole('button', { name: '取得影片' }),
  ];
  for (const control of controls) {
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }

  const motionStyle = await controls[2]!.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      animationDuration: style.animationDuration,
      transitionDuration: style.transitionDuration,
    };
  });
  expect(cssTimeToMilliseconds(motionStyle.animationDuration)).toBeLessThanOrEqual(0.001);
  expect(cssTimeToMilliseconds(motionStyle.transitionDuration)).toBeLessThanOrEqual(0.001);

  await page
    .locator('.site-footer')
    .getByRole('link', { name: /著作權/u })
    .click();
  const dialog = page.getByRole('dialog', { name: '著作權與下架通知' });
  await expect(dialog).toBeVisible();
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox).not.toBeNull();
  expect(dialogBox!.x).toBeGreaterThanOrEqual(0);
  expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(viewport.innerWidth);
});

import { expect, test } from '@playwright/test';

test('offers an accessible keyboard-first validation flow', async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));

  await page.goto('/');

  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hant');
  await expect(page.getByRole('main')).toHaveCount(1);

  const headings = page.getByRole('heading', { level: 1 });
  await expect(headings).toHaveCount(1);
  await expect(headings).toHaveAccessibleName('Threads Downloader');

  const input = page.getByRole('textbox', { name: '公開貼文網址' });
  const submit = page.getByRole('button', { name: '準備下載' });
  await expect(input).toHaveAccessibleName('公開貼文網址');
  await expect(input).toHaveAccessibleDescription('僅接受授權下載的公開內容。');
  await expect(submit).toBeVisible();

  await page.keyboard.press('Tab');
  await expect(input).toBeFocused();
  const focusOutline = await input.evaluate((element) => {
    const style = getComputedStyle(element);
    return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
  });
  expect(focusOutline.outlineStyle).not.toBe('none');
  expect(Number.parseFloat(focusOutline.outlineWidth)).toBeGreaterThan(0);

  await page.keyboard.press('Tab');
  await expect(submit).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await input.fill('not-a-url');
  await page.keyboard.press('Tab');

  await expect(page.getByRole('alert')).toHaveText('請輸入有效的網址。');
  await expect(input).toHaveAccessibleDescription('僅接受授權下載的公開內容。 請輸入有效的網址。');
  const liveStatus = page.getByText('尚未開始下載。', { exact: true });
  await expect(liveStatus).toHaveAttribute('aria-live', 'polite');
  expect(pageErrors).toEqual([]);
});

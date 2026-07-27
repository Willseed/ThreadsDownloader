import { type Page } from '@playwright/test';

import {
  CANDIDATE_ID,
  PRIVATE_DOM_VALUES,
  SAFE_API_ERROR_MESSAGE,
  SAFE_REQUEST_ID,
  THREADS_POST_URL,
  expect,
  test,
} from './fixtures/downloader-mock.js';

const MAX_PRIMARY_SUCCESS_ACTIONS = 10;
const PRIMARY_SUCCESS_ACTIONS = [
  'fill-post-url',
  'confirm-content-rights',
  'complete-turnstile',
  'submit-resolution',
  'handoff-candidate-download',
] as const;
type PrimarySuccessAction = (typeof PRIMARY_SUCCESS_ACTIONS)[number];

async function performPrimarySuccessAction(
  completedActions: PrimarySuccessAction[],
  action: PrimarySuccessAction,
  operation: () => Promise<unknown>,
): Promise<void> {
  await operation();
  completedActions.push(action);
}

async function waitForVerifiedChallenge(page: Page): Promise<void> {
  const turnstile = page.locator('.turnstile-container');
  await expect(turnstile).toHaveAttribute('aria-label', 'Cloudflare Turnstile');
  await expect(turnstile.getByRole('status', { name: '安全驗證測試替身' })).toHaveText(
    '安全驗證已完成',
  );
  await expect(page.locator('#challenge-title, .challenge-block')).toHaveCount(0);
}

async function completeResolveForm(page: Page): Promise<void> {
  await page.getByRole('textbox', { name: 'Threads 貼文網址' }).fill(THREADS_POST_URL);
  await page.getByRole('checkbox', { name: /我確認我有權下載/u }).check();
}

test('hands a resolved candidate to the browser without claiming download completion', async ({
  page,
  mockApi,
}) => {
  const completedActions: PrimarySuccessAction[] = [];
  await page.goto('/');

  await performPrimarySuccessAction(completedActions, 'fill-post-url', () =>
    page.getByRole('textbox', { name: 'Threads 貼文網址' }).fill(THREADS_POST_URL),
  );
  await performPrimarySuccessAction(completedActions, 'confirm-content-rights', () =>
    page.getByRole('checkbox', { name: /我確認我有權下載/u }).check(),
  );
  // The fake completes automatically, but the external challenge remains one semantic user action.
  await performPrimarySuccessAction(completedActions, 'complete-turnstile', () =>
    waitForVerifiedChallenge(page),
  );

  await performPrimarySuccessAction(completedActions, 'submit-resolution', () =>
    page.getByRole('button', { name: '取得影片' }).click(),
  );
  await expect(page.getByRole('heading', { name: 'research-video-01.mp4' })).toBeVisible();
  expect(mockApi.calls.session).toBe(1);
  expect(mockApi.calls.resolve).toBe(1);

  const downloadEvent = page.waitForEvent('download');
  await performPrimarySuccessAction(completedActions, 'handoff-candidate-download', () =>
    page.getByRole('button', { name: /^開啟或下載影片/u }).click(),
  );
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe('research-video-01.mp4');
  await download.cancel();

  await expect(
    page.getByText('已交由瀏覽器處理；若開啟播放器，請使用瀏覽器的儲存功能。'),
  ).toBeVisible();
  await expect(page.getByText(/下載完成|儲存成功/u)).toHaveCount(0);
  expect(mockApi.calls.downloadSessions).toBe(1);
  expect(mockApi.calls.downloads).toBe(1);

  const dom = await page.locator('html').evaluate((element) => element.outerHTML);
  for (const privateValue of PRIVATE_DOM_VALUES) {
    expect(dom).not.toContain(privateValue);
  }
  expect(dom).not.toContain(CANDIDATE_ID);

  expect(completedActions).toEqual(PRIMARY_SUCCESS_ACTIONS);
  expect(completedActions.length).toBeLessThanOrEqual(MAX_PRIMARY_SUCCESS_ACTIONS);
});

test('rejects invalid URL and missing rights before resolve is requested', async ({
  page,
  mockApi,
}) => {
  await page.goto('/');
  await waitForVerifiedChallenge(page);

  const input = page.getByRole('textbox', { name: 'Threads 貼文網址' });
  const submit = page.getByRole('button', { name: '取得影片' });
  await input.fill('not-a-url');
  await submit.click();
  await expect(
    page.getByRole('alert').filter({ hasText: '請輸入有效的公開 Threads 貼文網址。' }),
  ).toBeVisible();
  expect(mockApi.calls.resolve).toBe(0);

  await input.fill(THREADS_POST_URL);
  await submit.click();
  await expect(
    page.getByRole('alert').filter({ hasText: '必須先確認內容使用權利。' }),
  ).toBeVisible();
  expect(mockApi.calls.resolve).toBe(0);
});

test('exposes a safe API error through an alert without duplicate busy submissions', async ({
  page,
  mockApi,
}) => {
  mockApi.resolveDelayMs = 1_000;
  mockApi.failResolveWithSafeError();
  await page.goto('/');
  await waitForVerifiedChallenge(page);
  await completeResolveForm(page);

  const submit = page.getByRole('button', { name: '取得影片' });
  await submit.click();
  await expect(page.getByRole('button', { name: '正在取得影片……' })).toBeDisabled();
  await page
    .locator('button.primary-action')
    .evaluate((element) => (element as HTMLButtonElement).click());

  const error = page.getByRole('alert').filter({ hasText: SAFE_API_ERROR_MESSAGE });
  await expect(error).toBeVisible();
  await expect(error).toContainText(`參考編號：${SAFE_REQUEST_ID}`);
  await expect(page.getByText('無法取得影片，請查看下方訊息。')).toHaveCount(0);
  expect(mockApi.calls.resolve).toBe(1);
});

test('keeps legal documents optional while preserving direct shareable routes', async ({
  page,
  mockApi,
}) => {
  await page.goto('/');
  await waitForVerifiedChallenge(page);

  const termsTrigger = page.getByRole('link', { name: '查看內容使用責任', exact: true });
  await expect(page.locator('.service-boundary')).toHaveCount(0);
  await expect(page.getByText('法務與資料處理全文採需要時載入')).toHaveCount(0);
  await expect(page.getByText('本服務不授予任何第三方內容權利')).toHaveCount(0);
  await termsTrigger.click();

  const dialog = page.getByRole('dialog', { name: '使用條款' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('本服務不授予任何第三方內容權利')).toBeVisible();
  await expect(page).toHaveURL('/');
  expect(mockApi.calls.resolve).toBe(0);
  expect(mockApi.calls.downloadSessions).toBe(0);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(termsTrigger).toBeFocused();
  await expect(page.getByText('本服務不授予任何第三方內容權利')).toHaveCount(0);

  await page.goto('/privacy');
  await expect(page.getByRole('heading', { level: 1, name: '隱私與資料處理說明' })).toBeVisible();
  await expect(page).toHaveURL('/privacy');
});

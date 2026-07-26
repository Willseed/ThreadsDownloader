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
  await expect(page.getByText('安全驗證已通過，可提交解析。')).toBeVisible();
}

async function completeResolveForm(page: Page): Promise<void> {
  await page.getByRole('textbox', { name: 'Threads 公開貼文網址' }).fill(THREADS_POST_URL);
  await page.getByRole('checkbox', { name: /我確認我擁有內容/u }).check();
}

test('hands a resolved candidate to the browser without claiming download completion', async ({
  page,
  mockApi,
}) => {
  const completedActions: PrimarySuccessAction[] = [];
  await page.goto('/');

  await performPrimarySuccessAction(completedActions, 'fill-post-url', () =>
    page.getByRole('textbox', { name: 'Threads 公開貼文網址' }).fill(THREADS_POST_URL),
  );
  await performPrimarySuccessAction(completedActions, 'confirm-content-rights', () =>
    page.getByRole('checkbox', { name: /我確認我擁有內容/u }).check(),
  );
  // The fake completes automatically, but the external challenge remains one semantic user action.
  await performPrimarySuccessAction(completedActions, 'complete-turnstile', () =>
    waitForVerifiedChallenge(page),
  );

  await performPrimarySuccessAction(completedActions, 'submit-resolution', () =>
    page.getByRole('button', { name: '解析影片候選' }).click(),
  );
  await expect(page.getByRole('heading', { name: 'research-video-01.mp4' })).toBeVisible();
  expect(mockApi.calls.session).toBe(1);
  expect(mockApi.calls.resolve).toBe(1);

  const downloadEvent = page.waitForEvent('download');
  await performPrimarySuccessAction(completedActions, 'handoff-candidate-download', () =>
    page.getByRole('button', { name: '交給瀏覽器下載' }).click(),
  );
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe('research-video-01.mp4');
  await download.cancel();

  await expect(page.getByText('已交由瀏覽器下載管理器處理。')).toBeVisible();
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

  const input = page.getByRole('textbox', { name: 'Threads 公開貼文網址' });
  const submit = page.getByRole('button', { name: '解析影片候選' });
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

  const submit = page.getByRole('button', { name: '解析影片候選' });
  await submit.click();
  await expect(page.getByRole('button', { name: '正在解析' })).toBeDisabled();
  await page
    .locator('button.primary-action')
    .evaluate((element) => (element as HTMLButtonElement).click());

  const error = page.getByRole('alert').filter({ hasText: SAFE_API_ERROR_MESSAGE });
  await expect(error).toBeVisible();
  await expect(error).toContainText(`參考編號：${SAFE_REQUEST_ID}`);
  await expect(page.getByText('操作未完成，請依錯誤訊息處理。')).toBeVisible();
  expect(mockApi.calls.resolve).toBe(1);
});

import { defineConfig, devices } from '@playwright/test';

const inCi = process.env['CI'] !== undefined;

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.spec.ts',
  fullyParallel: true,
  forbidOnly: inCi,
  retries: inCi ? 1 : 0,
  workers: inCi ? 1 : undefined,
  reporter: 'list',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: 'http://127.0.0.1:4200',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command:
      'npm exec --workspace=@threads-downloader/web -- ng serve --configuration development --host 127.0.0.1 --port 4200 --live-reload=false',
    url: 'http://127.0.0.1:4200',
    reuseExistingServer: !inCi,
    timeout: 120_000,
  },
});

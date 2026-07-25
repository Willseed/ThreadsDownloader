import { randomBytes } from 'node:crypto';

import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: '../../wrangler.test.jsonc' },
      miniflare: {
        bindings: {
          DOWNLOAD_ENCRYPTION_KEY: randomBytes(32).toString('base64url'),
          RESOLVED_MEDIA_GRANT_KEY: randomBytes(32).toString('base64'),
          SESSION_SIGNING_KEY: randomBytes(32).toString('base64'),
          TURNSTILE_SECRET: randomBytes(32).toString('base64'),
        },
      },
    }),
  ],
  test: {
    include: ['test-do/**/*.spec.ts'],
  },
});

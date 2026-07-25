import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reportsDirectory: fileURLToPath(new URL('../../coverage/web', import.meta.url)),
      reporter: ['text-summary', ['lcovonly', { projectRoot: repositoryRoot }]],
    },
  },
});

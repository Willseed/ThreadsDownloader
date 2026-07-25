import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts'],
    coverage: {
      include: ['src/**/*.ts'],
      provider: 'v8',
      reportsDirectory: fileURLToPath(new URL('../../coverage/contracts', import.meta.url)),
      reporter: ['text-summary', ['lcovonly', { projectRoot: repositoryRoot }]],
    },
  },
});

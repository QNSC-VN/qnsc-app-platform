import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/support/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    // One Postgres and one Valkey for the whole run; every file gets its own database.
    fileParallelism: true,
  },
});

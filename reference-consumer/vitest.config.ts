import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 240_000,
    // One stack (three containers, a few processes) per file; files run one after another.
    fileParallelism: false,
  },
});

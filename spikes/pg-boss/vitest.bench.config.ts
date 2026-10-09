import { defineConfig } from 'vitest/config';

// The long measurements (a 30-minute transcode, 10 minutes of load) are runs, not unit tests:
// they take longer than any CI job and write their numbers to results/. They live in
// `*.run.ts` files so `pnpm test` never picks them up.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/bench/**/*.run.ts'],
    fileParallelism: false,
    pool: 'forks',
    testTimeout: 4 * 3600_000,
    hookTimeout: 300_000,
  },
});

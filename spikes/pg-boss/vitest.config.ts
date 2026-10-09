import { defineConfig } from 'vitest/config';

// The spike has its own config on purpose: the root `pnpm test` covers `packages/**` and runs on
// every PR, while these scenarios start real Postgres containers and child processes and take
// minutes. Run them with `pnpm --filter @quynhonsemiconductor/spike-pg-boss test`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // One Postgres container per file, one file at a time: the scenarios measure latency, and two
    // files competing for the same Docker VM would measure each other.
    fileParallelism: false,
    pool: 'forks',
    testTimeout: 300_000,
    hookTimeout: 180_000,
  },
});

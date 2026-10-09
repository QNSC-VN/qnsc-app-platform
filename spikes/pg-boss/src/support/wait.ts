/** Poll `probe` until it returns something other than `undefined`/`false`, or fail loudly. */
export async function waitFor<T>(
  probe: () => Promise<T | undefined | false> | T | undefined | false,
  what: string,
  { timeoutMs = 30_000, intervalMs = 100 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined && value !== false) return value;
    } catch (error) {
      // A probe is a read against a database that scenarios deliberately stress, kill workers
      // beside and, over an hour-long run, occasionally stall: a failed read is "not yet", and
      // the deadline reports it if it never recovers.
      lastError = error;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${timeoutMs} ms waiting for ${what}` +
          (lastError
            ? ` (last probe error: ${String((lastError as Error).message ?? lastError)})`
            : ''),
      );
    }
    await sleep(intervalMs);
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Nearest-rank percentile of an unsorted sample, `p` in (0, 100]. */
export function percentile(sample: readonly number[], p: number): number {
  if (sample.length === 0) return NaN;
  const sorted = [...sample].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!;
}

export function summarise(sample: readonly number[]): {
  n: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
} {
  const n = sample.length;
  return {
    n,
    min: Math.min(...sample),
    p50: percentile(sample, 50),
    p95: percentile(sample, 95),
    p99: percentile(sample, 99),
    max: Math.max(...sample),
    mean: sample.reduce((a, b) => a + b, 0) / n,
  };
}

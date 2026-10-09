/**
 * How long `stop()` may wait for active jobs, derived from the SAME environment as
 * `platform-runtime`'s `enableGracefulShutdown`, so a product configures the grace period once.
 *
 * The runtime's whole sequence is bounded by `SHUTDOWN_TIMEOUT_MS` (default 25 s, inside the
 * chart's 30 s grace period), and in an HTTP process it first spends `SHUTDOWN_ENDPOINT_DELAY_MS`
 * (default 5 s in a pod, 0 elsewhere) waiting for endpoint removal. A worker (no HTTP server)
 * spends none. Jobs stop in
 * `beforeApplicationShutdown`, after that delay and the HTTP drain. What is left, minus a reserve
 * for closing the pool and flushing telemetry, is the budget. ADR 0001, F5: "the pod grace period
 * minus the endpoint-removal delay".
 *
 * A job still running when the budget ends is failed (it spends one retry) and runs again on
 * another worker.
 */
const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_ENDPOINT_DELAY_MS = 5_000;
/** For `pool.end()` and the telemetry flush that follow `stop()`. */
const RESERVE_MS = 3_000;
const MIN_BUDGET_MS = 1_000;

function ms(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

export function stopBudgetMs(env: NodeJS.ProcessEnv = process.env, hasHttpServer = true): number {
  const timeout = ms(env, 'SHUTDOWN_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
  // A worker has no HTTP server, so `enableGracefulShutdown` skips the endpoint-removal delay for
  // it: nothing was waited for, and the whole deadline is available.
  const delay = !hasHttpServer
    ? 0
    : ms(
        env,
        'SHUTDOWN_ENDPOINT_DELAY_MS',
        env['KUBERNETES_SERVICE_HOST'] ? DEFAULT_ENDPOINT_DELAY_MS : 0,
      );
  return Math.max(MIN_BUDGET_MS, timeout - delay - RESERVE_MS);
}

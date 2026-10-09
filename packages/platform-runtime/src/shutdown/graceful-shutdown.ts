import { Logger, type INestApplicationContext } from '@nestjs/common';
import { healthRegistryOf } from '../health/enable-health';

/**
 * The chart's `terminationGracePeriodSeconds` default is 30. After it the kubelet SIGKILLs the
 * container, which cuts whatever is still running and skips every close hook. The deadline
 * below is a few seconds inside it so the process leaves on its own terms.
 */
const DEFAULT_TIMEOUT_MS = 25_000;
/**
 * After a pod is marked Terminating, the endpoint removal has to reach kube-proxy / the gateway
 * before new requests stop arriving; until then they are still routed here. Staying up and
 * answering during that window is what keeps a rolling deploy from dropping them.
 */
const DEFAULT_ENDPOINT_DELAY_MS = 5_000;

export interface GracefulShutdownOptions {
  /**
   * Test seam. Defaults to `process.env`. In a real deployment these come from the pod:
   *
   * - `SHUTDOWN_TIMEOUT_MS`        hard deadline for the whole sequence (default 25000; raise it
   *                                with the chart's `terminationGracePeriodSeconds`, keep it below)
   * - `SHUTDOWN_ENDPOINT_DELAY_MS` how long to keep serving after going not-ready (default 5000
   *                                in a Kubernetes pod, detected by `KUBERNETES_SERVICE_HOST`, and
   *                                0 elsewhere so Ctrl-C on a laptop is immediate)
   */
  env?: NodeJS.ProcessEnv;
  /** Test seam. Defaults to `process.exit`. */
  exit?: (code: number) => void;
  /** Test seam. Defaults to `['SIGTERM', 'SIGINT']`; pass `[]` to install no signal handlers. */
  signals?: NodeJS.Signals[];
}

export interface GracefulShutdown {
  /** Run the sequence now. Idempotent: a second call returns the first call's promise. */
  shutdown(reason: string): Promise<void>;
  readonly isShuttingDown: boolean;
  /** The values in effect, after defaults and the environment. */
  readonly endpointDelayMs: number;
  readonly timeoutMs: number;
  /** Remove the signal handlers. */
  dispose(): void;
}

function readMs(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 600_000) {
    throw new Error(
      `${name} must be an integer number of milliseconds between 0 and 600000, received "${raw}".`,
    );
  }
  return value;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    if (ms <= 0) return resolve();
    setTimeout(resolve, ms);
  });

/**
 * One implementation of "leave the Service cleanly" instead of one hand-written SIGTERM handler
 * per `main.ts`. On SIGTERM (or SIGINT):
 *
 *   1. `/readyz` starts answering 503, so the pod is out of rotation          (not-ready)
 *   2. keep serving for the endpoint-removal delay, so requests already routed here land
 *   3. stop accepting connections and wait for in-flight requests to finish   (drain)
 *   4. `app.close()` runs Nest's hooks, in Nest's order:
 *        a. `onModuleDestroy`            (anything that has no ordering needs)
 *        b. `beforeApplicationShutdown`  stop doing work: the job runner stops here
 *        c. (the HTTP server, already drained in step 3)
 *        d. `onApplicationShutdown`      release shared resources: database pool, cache
 *   5. flush OpenTelemetry, then exit 0                                        (exit)
 *
 * The whole sequence is bounded by `SHUTDOWN_TIMEOUT_MS`; past it the process exits 1 rather
 * than wait for the kubelet's SIGKILL.
 *
 * TWO ORDERS, BOTH DELIBERATE.
 *
 * 1. HTTP drains BEFORE `app.close()`. Nest's own `close()` runs the destroy hooks first and
 *    closes the HTTP server only afterwards, so a bare `app.close()` tears providers down while
 *    requests are still using them.
 * 2. Within `app.close()`, work stops before the resources it uses are released. That is why
 *    `platform-db` ends its pool and `platform-cache` quits its client in
 *    `onApplicationShutdown` (a job runner stops in `beforeApplicationShutdown`, which Nest runs
 *    earlier). A provider of your own follows the same rule: stop work in
 *    `beforeApplicationShutdown`, release connections in `onApplicationShutdown`.
 *
 * A hook that THROWS ends Nest's close sequence: the hooks after it do not run, so a throwing
 * `onModuleDestroy` leaves the pool and cache open. Catch and log inside hooks.
 *
 * DO NOT call `app.enableShutdownHooks()` as well: Nest would register its own SIGTERM handler
 * that runs `app.close()` immediately, with no readiness flip, no delay and no HTTP drain, and
 * then re-signals the process. This function refuses to start if it is already enabled.
 *
 * Works for a worker too (`createApplicationContext`, no HTTP): steps 1-3 are skipped.
 */
export function enableGracefulShutdown(
  app: INestApplicationContext,
  options: GracefulShutdownOptions = {},
): GracefulShutdown {
  const env = options.env ?? process.env;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const signals = options.signals ?? (['SIGTERM', 'SIGINT'] as NodeJS.Signals[]);
  const logger = new Logger('Shutdown');

  if (nestShutdownHooksEnabled(app)) {
    throw new Error(
      'enableGracefulShutdown() cannot be used together with app.enableShutdownHooks(): Nest would ' +
        'run app.close() on SIGTERM straight away, skipping the readiness flip, the endpoint-removal ' +
        'delay and the HTTP drain, and then re-send the signal. Remove the enableShutdownHooks() call.',
    );
  }

  const timeoutMs = readMs(env, 'SHUTDOWN_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
  const delayMs = readMs(
    env,
    'SHUTDOWN_ENDPOINT_DELAY_MS',
    env['KUBERNETES_SERVICE_HOST'] ? DEFAULT_ENDPOINT_DELAY_MS : 0,
  );

  if (delayMs >= timeoutMs) {
    throw new Error(
      `SHUTDOWN_ENDPOINT_DELAY_MS (${delayMs}) must be smaller than SHUTDOWN_TIMEOUT_MS (${timeoutMs}), ` +
        'or the deadline expires before the drain can start.',
    );
  }

  let running: Promise<void> | undefined;

  const run = async (reason: string): Promise<void> => {
    const startedAt = Date.now();
    logger.log(`Received ${reason}; shutting down (delay ${delayMs} ms, deadline ${timeoutMs} ms)`);

    if (nestShutdownHooksEnabled(app)) {
      // Enabled AFTER this function ran, so the check at startup could not see it.
      logger.error(
        'app.enableShutdownHooks() is also active: Nest is closing the application on its own ' +
          'signal handler, outside this sequence. Remove that call.',
      );
    }

    let failed = false;
    // Deliberately NOT unref'd. The deadline must keep the event loop alive: if a step hangs on
    // a promise that never settles and no socket or timer is left, an unref'd timer lets Node
    // fall out of the loop and exit with code 0, which reports a hung shutdown as a clean one.
    const hardStop = setTimeout(() => {
      logger.error(`Shutdown did not finish within ${timeoutMs} ms; exiting`);
      exit(1);
    }, timeoutMs);

    const step = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        failed = true;
        logger.error(
          `Shutdown step "${name}" failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };

    const http = httpAdapterOf(app);
    if (http) {
      healthRegistryOf(app)?.beginShutdown();
      await step('endpoint-removal delay', () => sleep(delayMs));
      await step('drain http', () => drain(app, http));
    }
    await step('close application', () => app.close());
    await step('flush telemetry', flushTelemetry);

    clearTimeout(hardStop);
    logger.log(
      `Shutdown ${failed ? 'finished with errors' : 'complete'} in ${Date.now() - startedAt} ms`,
    );
    exit(failed ? 1 : 0);
  };

  const shutdown = (reason: string): Promise<void> => (running ??= run(reason));

  const handlers = signals.map((signal) => {
    const handler = () => {
      if (running) {
        logger.warn(`Received ${signal} while already shutting down; ignoring`);
        return;
      }
      void shutdown(signal);
    };
    process.on(signal, handler);
    return [signal, handler] as const;
  });

  return {
    shutdown,
    get isShuttingDown() {
      return running !== undefined;
    },
    endpointDelayMs: delayMs,
    timeoutMs,
    dispose() {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    },
  };
}

/** How often idle keep-alive sockets are swept while draining. */
const IDLE_SWEEP_MS = 100;

/**
 * Stop listening and wait until every in-flight request has been answered.
 *
 * `close()` alone is not enough, and the gap is a real outage: Fastify keeps keep-alive sockets
 * open for 72 s by default, and `close()` waits for all sockets. It closes the sockets that are
 * idle AT THE MOMENT it is called, but a socket whose request finishes during the drain goes
 * idle afterwards and stays open until its keep-alive expires, well past the pod's 30 s grace
 * period. Behind Envoy or Cloudflare there is always such a socket. So idle sockets are swept
 * until `close()` resolves.
 */
async function drain(
  app: INestApplicationContext,
  http: { close(): Promise<void> },
): Promise<void> {
  const server = (
    app as unknown as { getHttpServer?: () => { closeIdleConnections?: () => void } }
  ).getHttpServer?.();
  const sweep = setInterval(() => server?.closeIdleConnections?.(), IDLE_SWEEP_MS);
  try {
    await http.close();
  } finally {
    clearInterval(sweep);
  }
}

/**
 * Nest records the signals it listens on in `activeShutdownSignals` (private, stable since v8)
 * when `enableShutdownHooks()` is called.
 */
function nestShutdownHooksEnabled(app: INestApplicationContext): boolean {
  const signals = (app as unknown as { activeShutdownSignals?: unknown[] }).activeShutdownSignals;
  return Array.isArray(signals) && signals.length > 0;
}

function httpAdapterOf(app: INestApplicationContext): { close(): Promise<void> } | undefined {
  const withHttp = app as unknown as { getHttpAdapter?: () => { close(): Promise<void> } };
  return typeof withHttp.getHttpAdapter === 'function' ? withHttp.getHttpAdapter() : undefined;
}

/**
 * Flush pending spans. `startOtel` does nothing unless `OTEL_ENABLED=true`, and when it is
 * set the bootstrap module is already loaded by the product's entrypoint, so this import is a
 * cache hit. Without the guard, a process with telemetry off would load the whole OTel SDK
 * just to learn there is nothing to flush.
 */
async function flushTelemetry(): Promise<void> {
  if (process.env['OTEL_ENABLED'] !== 'true') return;
  const { shutdownOtel } = await import('@quynhonsemiconductor/observability/otel');
  await shutdownOtel();
}

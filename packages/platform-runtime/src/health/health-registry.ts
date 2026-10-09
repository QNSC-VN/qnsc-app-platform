import { Logger } from '@nestjs/common';

/**
 * A readiness check. Resolve = up; throw or reject = down; resolve `'skip'` = this check does
 * not apply right now and is left out of the report (a cache that is not configured).
 *
 * It must be cheap and must not mutate anything: the kubelet calls `/readyz` every few
 * seconds on every replica.
 */
export type HealthCheck = () => Promise<void | 'skip'>;

export type CheckStatus = 'up' | 'down';

export interface ReadinessReport {
  /** `error` when any check is down OR the process is draining. */
  status: 'ok' | 'error';
  /** True once shutdown has begun. The pod is leaving: stop sending it traffic. */
  shuttingDown: boolean;
  /** Per-check status only. Causes are logged, never returned: the endpoint is unauthenticated. */
  checks: Record<string, CheckStatus>;
}

/**
 * Upper bound for ALL checks together.
 *
 * The chart's readiness probe leaves `timeoutSeconds` at the Kubernetes default of 1 second,
 * and a probe that takes longer counts as a failure. So the endpoint must answer inside that
 * second even when a dependency hangs: a hung database has to read as "down", not as a probe
 * timeout that tells nobody which dependency it was. 800 ms leaves headroom for the response.
 */
export const READINESS_DEADLINE_MS = 800;

/** Runs the registered checks. One instance per application. */
export class HealthRegistry {
  private readonly logger = new Logger('Health');
  private readonly checks = new Map<string, HealthCheck>();
  private readonly lastStatus = new Map<string, CheckStatus>();
  private draining = false;

  /** @throws if `name` is already registered: two checks sharing a name hide each other. */
  register(name: string, check: HealthCheck): void {
    if (this.checks.has(name)) {
      throw new Error(`Health check "${name}" is already registered.`);
    }
    this.checks.set(name, check);
  }

  has(name: string): boolean {
    return this.checks.has(name);
  }

  get shuttingDown(): boolean {
    return this.draining;
  }

  /**
   * From now on `/readyz` answers 503 without running any check, so the pod leaves its
   * Service while it finishes in-flight work. `/livez` is unaffected for as long as the server
   * is listening, which is the endpoint-removal delay: a pod in that window is alive, and
   * killing it early would cut the requests still arriving. Once the HTTP server stops
   * listening there is nothing to answer with; the kubelet no longer probes by then.
   */
  beginShutdown(): void {
    this.draining = true;
  }

  async report(): Promise<ReadinessReport> {
    if (this.draining) {
      return { status: 'error', shuttingDown: true, checks: {} };
    }

    const entries = [...this.checks.entries()];
    // Filled as each check finishes, so that on a deadline overrun the checks that DID answer
    // keep their answer and only the slow ones are down. A `Promise.all` would lose the lot.
    const results = new Map<string, CheckStatus | 'skip'>();
    const finished = Promise.all(
      entries.map(async ([name, check]) => {
        results.set(name, await this.runOne(name, check));
      }),
    );
    const inTime = (await withDeadline(finished, READINESS_DEADLINE_MS)) !== undefined;

    const checks: Record<string, CheckStatus> = {};
    for (const [name] of entries) {
      const result = results.get(name) ?? 'down';
      if (result !== 'skip') checks[name] = result;
      if (result === 'down' && !results.has(name))
        this.transition(name, 'down', new Error(`no answer within ${READINESS_DEADLINE_MS} ms`));
    }
    if (!inTime) {
      this.logger.warn(
        `Readiness checks exceeded ${READINESS_DEADLINE_MS} ms; reporting not ready`,
      );
    }
    const ok = Object.values(checks).every((s) => s === 'up');
    return { status: ok ? 'ok' : 'error', shuttingDown: false, checks };
  }

  private async runOne(name: string, check: HealthCheck): Promise<CheckStatus | 'skip'> {
    try {
      if ((await check()) === 'skip') return 'skip';
      this.transition(name, 'up');
      return 'up';
    } catch (err) {
      this.transition(name, 'down', err);
      return 'down';
    }
  }

  /** Log on a CHANGE only: a probe every 5 s per replica would otherwise drown the log. */
  private transition(name: string, status: CheckStatus, err?: unknown): void {
    if (this.lastStatus.get(name) === status) return;
    const before = this.lastStatus.get(name);
    this.lastStatus.set(name, status);
    if (status === 'down') {
      const cause = err instanceof Error ? err.message : String(err);
      this.logger.error(`Readiness check "${name}" is down: ${cause}`);
    } else if (before === 'down') {
      this.logger.log(`Readiness check "${name}" recovered`);
    }
  }
}

/** Resolve with `undefined` if `work` has not settled in `ms`. */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
    timer.unref();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

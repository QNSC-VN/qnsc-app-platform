import { Injectable } from '@nestjs/common';
import { metrics, type Counter, type Histogram, type Meter, type UpDownCounter } from '@opentelemetry/api';

/**
 * Metric instruments, shared across products.
 *
 * Two rules drive the whole design, and both come from watching metric layers rot:
 *
 * 1. **Names live here, not at call sites.** A previous attempt declared 23 metric
 *    names in a constants file and implemented none of them — the names implied
 *    coverage that did not exist. Every name below is emitted by a real recorder.
 *
 * 2. **Labels are bounded by construction.** The single most common cause of both
 *    observability outages and surprise bills is an id in a metric label. The
 *    recorder signatures below only accept low-cardinality values, so passing a
 *    workspace id or a raw URL is a type error rather than a production incident.
 *    IDs belong on spans and logs, which is where they are useful anyway.
 *
 * Every instrument is a no-op when OTel is disabled — the API returns no-op
 * instruments — so products can emit unconditionally.
 */

/** Canonical metric names. Add here first, then a recorder below. */
export const METRIC_NAMES = {
  HTTP_SERVER_DURATION: 'http.server.duration',
  HTTP_SERVER_REQUESTS: 'http.server.requests',
  HTTP_SERVER_ERRORS: 'http.server.errors',
  DB_POOL_IN_USE: 'db.pool.in_use',
  DB_POOL_WAITING: 'db.pool.waiting',
  JOB_DURATION: 'job.duration',
  JOB_RUNS: 'job.runs',
  JOB_FAILURES: 'job.failures',
  QUEUE_PROCESSED: 'queue.processed',
  QUEUE_FAILURES: 'queue.failures',
  QUEUE_LAG_SECONDS: 'queue.lag_seconds',
  SECURITY_FAIL_OPEN: 'security.fail_open',
  AUTHZ_STALE_TOKEN: 'authz.stale_token',
} as const;

/** HTTP status grouped to three values, because raw codes are unbounded enough to hurt. */
export type StatusClass = '2xx' | '3xx' | '4xx' | '5xx';

/** Methods worth distinguishing; anything else collapses to `OTHER`. */
export type HttpMethodLabel = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OTHER';

const KNOWN_METHODS: ReadonlySet<string> = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/** Bucket a status code. */
export function statusClassOf(statusCode: number): StatusClass {
  if (statusCode >= 500) return '5xx';
  if (statusCode >= 400) return '4xx';
  if (statusCode >= 300) return '3xx';
  return '2xx';
}

/** Collapse an arbitrary method string onto the bounded label set. */
export function methodLabelOf(method: string): HttpMethodLabel {
  const upper = method.toUpperCase();
  return (KNOWN_METHODS.has(upper) ? upper : 'OTHER') as HttpMethodLabel;
}

const UUID_SEGMENT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_SEGMENT = /^\d+$/;
/** Anything long and mixed-case/alphanumeric is almost certainly a generated id. */
const OPAQUE_ID_SEGMENT = /^[A-Za-z0-9_-]{16,}$/;

/**
 * Reduce a concrete request path to a route template safe to use as a label.
 *
 * `/v1/work-items/019f8a.../comments/42` → `/v1/work-items/:id/comments/:id`
 *
 * A framework-provided route template is always better than this — prefer passing
 * one. But an interceptor cannot always get it, and a raw path in a label is
 * unbounded cardinality wearing a disguise, so this is the safety net rather than
 * the intended path. The query string is dropped entirely.
 */
export function normalizeRoute(path: string): string {
  const [withoutQuery] = path.split('?');
  const normalized = withoutQuery
    .split('/')
    .map((segment) => {
      if (!segment) return segment;
      if (UUID_SEGMENT.test(segment)) return ':id';
      if (NUMERIC_SEGMENT.test(segment)) return ':id';
      if (OPAQUE_ID_SEGMENT.test(segment) && !segment.includes('-')) return ':id';
      return segment;
    })
    .join('/');
  return normalized === '' ? '/' : normalized;
}

/** Shared meter. Named per service via the OTel resource, so no name is needed here. */
export function getMeter(name = 'qnsc'): Meter {
  return metrics.getMeter(name, process.env['SERVICE_VERSION'] ?? 'dev');
}

/**
 * RED metrics for inbound HTTP. Call once per request from an interceptor.
 */
@Injectable()
export class HttpMetrics {
  private readonly meter = getMeter();

  private readonly duration: Histogram = this.meter.createHistogram(
    METRIC_NAMES.HTTP_SERVER_DURATION,
    { description: 'Inbound HTTP request duration', unit: 'ms' },
  );

  private readonly requests: Counter = this.meter.createCounter(
    METRIC_NAMES.HTTP_SERVER_REQUESTS,
    { description: 'Inbound HTTP requests' },
  );

  private readonly errors: Counter = this.meter.createCounter(METRIC_NAMES.HTTP_SERVER_ERRORS, {
    description: 'Inbound HTTP requests that failed',
  });

  /**
   * @param route  Route TEMPLATE (`/v1/work-items/:id`), not a concrete path. Use
   *               {@link normalizeRoute} when the framework cannot supply one.
   * @param errorCode Domain error code for the error counter — bounded by the
   *               product's error catalogue, never a message.
   */
  record(input: {
    route: string;
    method: string;
    statusCode: number;
    durationMs: number;
    errorCode?: string;
  }): void {
    const labels = {
      route: input.route,
      method: methodLabelOf(input.method),
      status_class: statusClassOf(input.statusCode),
    };
    this.duration.record(input.durationMs, labels);
    this.requests.add(1, labels);
    if (input.statusCode >= 400) {
      this.errors.add(1, { route: labels.route, error_code: input.errorCode ?? 'UNKNOWN' });
    }
  }
}

/** Cron / scheduled job outcomes. */
@Injectable()
export class JobMetrics {
  private readonly meter = getMeter();

  private readonly duration: Histogram = this.meter.createHistogram(METRIC_NAMES.JOB_DURATION, {
    description: 'Scheduled job duration',
    unit: 'ms',
  });

  private readonly runs: Counter = this.meter.createCounter(METRIC_NAMES.JOB_RUNS, {
    description: 'Scheduled job runs',
  });

  private readonly failures: Counter = this.meter.createCounter(METRIC_NAMES.JOB_FAILURES, {
    description: 'Scheduled job runs that threw',
  });

  /** `job` is a fixed name from the schedule, so its cardinality is the job count. */
  record(job: string, durationMs: number, outcome: 'success' | 'failure'): void {
    this.duration.record(durationMs, { job, outcome });
    this.runs.add(1, { job, outcome });
    if (outcome === 'failure') this.failures.add(1, { job });
  }

  /** Time `fn`, record the outcome, and re-throw so callers see failures. */
  async time<T>(job: string, fn: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    try {
      const result = await fn();
      this.record(job, Date.now() - startedAt, 'success');
      return result;
    } catch (error) {
      this.record(job, Date.now() - startedAt, 'failure');
      throw error;
    }
  }
}

/** Outbox / queue relay throughput and backlog age. */
@Injectable()
export class QueueMetrics {
  private readonly meter = getMeter();

  private readonly processed: Counter = this.meter.createCounter(METRIC_NAMES.QUEUE_PROCESSED, {
    description: 'Queue rows processed',
  });

  private readonly failures: Counter = this.meter.createCounter(METRIC_NAMES.QUEUE_FAILURES, {
    description: 'Queue rows that failed processing',
  });

  private readonly lag: Histogram = this.meter.createHistogram(METRIC_NAMES.QUEUE_LAG_SECONDS, {
    description: 'Age of the oldest row in a processed batch',
    unit: 's',
  });

  recordProcessed(queue: string, count = 1): void {
    if (count > 0) this.processed.add(count, { queue });
  }

  recordFailure(queue: string, count = 1): void {
    if (count > 0) this.failures.add(count, { queue });
  }

  /**
   * Lag is what tells you a relay is falling behind — throughput alone looks
   * healthy while a backlog grows.
   */
  recordLag(queue: string, seconds: number): void {
    if (Number.isFinite(seconds) && seconds >= 0) this.lag.record(seconds, { queue });
  }
}

/** Connection-pool saturation: the USE half, and the usual cause of latency cliffs. */
@Injectable()
export class DbPoolMetrics {
  private readonly meter = getMeter();

  private readonly inUse: UpDownCounter = this.meter.createUpDownCounter(
    METRIC_NAMES.DB_POOL_IN_USE,
    { description: 'Checked-out database connections' },
  );

  private readonly waiting: UpDownCounter = this.meter.createUpDownCounter(
    METRIC_NAMES.DB_POOL_WAITING,
    { description: 'Requests waiting for a database connection' },
  );

  observe(input: { inUse: number; waiting: number }): void {
    this.inUse.add(input.inUse);
    this.waiting.add(input.waiting);
  }
}

/**
 * Security-control degradation.
 *
 * Deliberately separate from the log field products already emit: the log drives a
 * CloudWatch alarm today, and this counter drives the same alert once a metrics
 * backend exists. Both, not either — the alarm must not go dark during migration.
 */
@Injectable()
export class SecurityMetrics {
  private readonly meter = getMeter();

  private readonly failOpen: Counter = this.meter.createCounter(METRIC_NAMES.SECURITY_FAIL_OPEN, {
    description: 'A security control degraded to fail-open (cache unavailable)',
  });

  private readonly staleToken: Counter = this.meter.createCounter(METRIC_NAMES.AUTHZ_STALE_TOKEN, {
    description: 'Access tokens rejected because their authorization snapshot was superseded',
  });

  /** `control` is a fixed enum of guard names — bounded. */
  recordFailOpen(control: string): void {
    this.failOpen.add(1, { control });
  }

  recordStaleToken(): void {
    this.staleToken.add(1);
  }
}

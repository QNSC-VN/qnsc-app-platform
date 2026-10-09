import { Injectable, Logger } from '@nestjs/common';
import {
  metrics,
  ValueType,
  type Counter,
  type Histogram,
  type Meter,
  type ObservableGauge,
} from '@opentelemetry/api';
import type { FailOpenControl } from './fail-open';

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
  AUTH_LOGIN: 'auth.login',
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
  const upper = String(method ?? '').toUpperCase();
  return (KNOWN_METHODS.has(upper) ? upper : 'OTHER') as HttpMethodLabel;
}

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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

/** What a value becomes once its label has seen too many distinct values. */
export const OVERFLOW_LABEL_VALUE = '__other__';

/** Longest label value kept; a longer one is cut, not rejected. */
const MAX_LABEL_VALUE_LENGTH = 128;

/** Distinct values allowed per label when no specific limit is listed. */
const DEFAULT_LABEL_LIMIT = 100;

/**
 * Distinct values allowed per label. These are tripwires, not budgets: a healthy product
 * stays far below them (rova and opshub expose ~265 and ~335 endpoints in total), and the
 * first value past the limit is almost always an id that slipped into a label. The point
 * is that the damage stops at the limit instead of growing with traffic.
 */
const LABEL_LIMITS: Readonly<Record<string, number>> = {
  route: 500,
  error_code: 200,
  job: DEFAULT_LABEL_LIMIT,
  queue: DEFAULT_LABEL_LIMIT,
};

/**
 * Runtime backstop for the one case the types cannot cover: a `string` label whose
 * value turns out to be unbounded.
 *
 * `route`, `error_code`, `job` and `queue` are plain strings because the vocabulary is the
 * product's. The recorder signatures steer callers to templates and codes, but a route
 * built from a raw path, or a job named after a tenant, type-checks perfectly and mints a
 * new time series per value — which is what exhausts a metrics backend's series quota and
 * turns a free tier into a bill. This remembers the distinct values seen per
 * (recorder, label) and, past the limit, records the overflow under
 * {@link OVERFLOW_LABEL_VALUE} instead. It logs ONCE per label so the leak is visible
 * without becoming its own log flood. Memory is bounded by `limit × 128` characters.
 *
 * Values already seen keep their own series after the limit is reached, so the counts that
 * were correct stay correct; only the unbounded tail is merged.
 */
export class LabelCardinalityGuard {
  private readonly logger = new Logger('MetricLabels');
  private readonly seen = new Map<string, Set<string>>();
  private readonly warned = new Set<string>();

  constructor(
    private readonly limits: Readonly<Record<string, number>> = LABEL_LIMITS,
    private readonly defaultLimit = DEFAULT_LABEL_LIMIT,
  ) {}

  /**
   * `scope` names the recorder (`http.server`), `label` the label key.
   *
   * TOTAL: it never throws and always returns a string, whatever it is given — a metric
   * is recorded from the request path, and telemetry must not be able to fail a request.
   * `undefined`/`null` become `UNKNOWN`, other non-strings are stringified, and anything
   * that still goes wrong (a hostile `toString`, say) is recorded as the overflow label.
   */
  bound(scope: string, label: string, value: unknown): string {
    try {
      const text = String(value ?? 'UNKNOWN');
      const bounded =
        text.length > MAX_LABEL_VALUE_LENGTH ? text.slice(0, MAX_LABEL_VALUE_LENGTH) : text;
      const key = `${scope}/${label}`;

      let values = this.seen.get(key);
      if (!values) {
        values = new Set();
        this.seen.set(key, values);
      }
      if (values.has(bounded)) return bounded;

      const limit = this.limits[label] ?? this.defaultLimit;
      if (values.size < limit) {
        values.add(bounded);
        return bounded;
      }

      if (!this.warned.has(key)) {
        this.warned.add(key);
        this.logger.warn(
          `Metric label "${label}" on ${scope} passed ${limit} distinct values; ` +
            `further new values are recorded as "${OVERFLOW_LABEL_VALUE}". ` +
            'An id or a raw path is probably being used as a label — pass a template or a code.',
        );
      }
      return OVERFLOW_LABEL_VALUE;
    } catch {
      return OVERFLOW_LABEL_VALUE;
    }
  }
}

/** One guard per process: recorders are constructed many times (DI and `new`). */
const labelGuard = new LabelCardinalityGuard();

const recorderLogger = new Logger('Metrics');
const failedRecorders = new Set<string>();

/**
 * Run a recorder body so that it cannot throw into the caller. Recorders are called from
 * request and job paths; a bad argument (an `undefined` route from an unmatched request, a
 * misbehaving OTel instrument) must cost a data point, never a response. This is the same
 * fail-open contract as the rest of the package. The first failure per recorder is logged,
 * the rest are not, so a systematic bug is visible without flooding the log.
 */
function safely(recorder: string, body: () => void): void {
  try {
    body();
  } catch (err) {
    if (failedRecorders.has(recorder)) return;
    failedRecorders.add(recorder);
    try {
      recorderLogger.warn(
        `${recorder} failed to record a metric (further failures not logged): ${String(err)}`,
      );
    } catch {
      // Logging must not throw either.
    }
  }
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

  private readonly requests: Counter = this.meter.createCounter(METRIC_NAMES.HTTP_SERVER_REQUESTS, {
    description: 'Inbound HTTP requests',
  });

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
    safely('HttpMetrics.record', () => {
      const labels = {
        route: labelGuard.bound('http.server', 'route', input.route),
        method: methodLabelOf(input.method),
        status_class: statusClassOf(input.statusCode),
      };
      this.duration.record(input.durationMs, labels);
      this.requests.add(1, labels);
      if (input.statusCode >= 400) {
        this.errors.add(1, {
          route: labels.route,
          error_code: labelGuard.bound('http.server', 'error_code', input.errorCode),
        });
      }
    });
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
    safely('JobMetrics.record', () => {
      const name = labelGuard.bound('job', 'job', job);
      this.duration.record(durationMs, { job: name, outcome });
      this.runs.add(1, { job: name, outcome });
      if (outcome === 'failure') this.failures.add(1, { job: name });
    });
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
    safely('QueueMetrics.recordProcessed', () => {
      if (count > 0)
        this.processed.add(count, { queue: labelGuard.bound('queue', 'queue', queue) });
    });
  }

  recordFailure(queue: string, count = 1): void {
    safely('QueueMetrics.recordFailure', () => {
      if (count > 0) this.failures.add(count, { queue: labelGuard.bound('queue', 'queue', queue) });
    });
  }

  /**
   * Lag is what tells you a relay is falling behind — throughput alone looks
   * healthy while a backlog grows.
   */
  recordLag(queue: string, seconds: number): void {
    safely('QueueMetrics.recordLag', () => {
      if (Number.isFinite(seconds) && seconds >= 0) {
        this.lag.record(seconds, { queue: labelGuard.bound('queue', 'queue', queue) });
      }
    });
  }
}

/** A point-in-time reading of a connection pool. */
export interface DbPoolReading {
  /** Connections currently checked out. */
  inUse: number;
  /** Callers queued waiting for a connection — the number that predicts a stall. */
  waiting: number;
}

/**
 * Connection-pool saturation: the USE half, and the usual cause of latency cliffs.
 *
 * Modelled as OBSERVABLE gauges, deliberately. A counter is the wrong instrument for
 * a pool reading — `UpDownCounter.add(3)` twice reports 6, not 3 — and a
 * product-side timer that pushed readings would be both duplicated per product and
 * out of step with the export interval. Instead the product registers a callback
 * once and OTel pulls it on each collection, so the value is always a true reading
 * at export time and there is no timer to own.
 */
@Injectable()
export class DbPoolMetrics {
  private readonly meter = getMeter();

  private readonly inUse: ObservableGauge = this.meter.createObservableGauge(
    METRIC_NAMES.DB_POOL_IN_USE,
    { description: 'Checked-out database connections', valueType: ValueType.INT },
  );

  private readonly waiting: ObservableGauge = this.meter.createObservableGauge(
    METRIC_NAMES.DB_POOL_WAITING,
    { description: 'Callers waiting for a database connection', valueType: ValueType.INT },
  );

  private registered = false;

  /**
   * Register the pool to observe. Call once at startup with a closure over the
   * driver's pool; `read` is invoked on every metric collection.
   *
   * Idempotent: a second call is ignored rather than double-registering, which would
   * report each value twice.
   */
  register(read: () => DbPoolReading): void {
    if (this.registered) return;
    this.registered = true;

    this.inUse.addCallback((result) => {
      result.observe(read().inUse);
    });
    this.waiting.addCallback((result) => {
      result.observe(read().waiting);
    });
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

  /**
   * `control` is the shared {@link FailOpenControl} union, not a string: the same
   * value is a metric label here and the value a log-based alarm matches, so the two
   * must agree by construction.
   */
  recordFailOpen(control: FailOpenControl): void {
    safely('SecurityMetrics.recordFailOpen', () => this.failOpen.add(1, { control }));
  }

  recordStaleToken(): void {
    safely('SecurityMetrics.recordStaleToken', () => this.staleToken.add(1));
  }
}

/**
 * "Is login itself working" — deliberately separate from HttpMetrics. A 5xx-rate
 * panel over `/bff/callback`/`/bff/dev-login` cannot distinguish a broken IdP
 * integration, an expired client secret, or a user mistyping an email from an
 * unrelated server error, because the BFF controller deliberately collapses every
 * login failure into one generic 401 (never surfaces OIDC/internal detail to the
 * browser) — so the HTTP status code alone carries no signal about WHICH kind of
 * failure this is. `outcome` and `method` are both bounded enums, never a raw
 * error message or provider response, so this cannot become an unbounded-label
 * incident the way a naive "log the IdP error as a label" attempt would.
 */
export type LoginMethod = 'sso' | 'dev';
export type LoginOutcome = 'success' | 'failure';

@Injectable()
export class AuthMetrics {
  private readonly meter = getMeter();

  private readonly login: Counter = this.meter.createCounter(METRIC_NAMES.AUTH_LOGIN, {
    description: 'Login attempts completing the BFF callback or dev-login, by method and outcome',
  });

  recordLogin(method: LoginMethod, outcome: LoginOutcome): void {
    safely('AuthMetrics.recordLogin', () => this.login.add(1, { method, outcome }));
  }
}

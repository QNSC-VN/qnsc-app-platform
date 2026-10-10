import { PgBoss, fromDrizzle } from 'pg-boss';
import type { Pool } from 'pg';
import type { DbExecutor } from '@quynhonsemiconductor/platform-db/drizzle';
import { QueueMetrics, withJobContext } from '@quynhonsemiconductor/observability';
import { bossOptions, roleFrom, type Role } from './boss-options';
import {
  DEFAULTS,
  DEFAULT_TIME_ZONE,
  JobsConfigError,
  assertQueueName,
  assertTimeZone,
  resolveHandler,
  resolveQueue,
  type ResolvedHandler,
  type ResolvedQueue,
} from './config';
import { HELD_CLAIMS_SQL } from './claims';
import { correlationIdFor } from './correlation';
import { isPermanent } from './errors';
import { idempotencyId } from './idempotency';
import { EFFECT_TABLE } from './install';
import { registerOldestReadyAge } from './metrics';
import { redriveDeadLetters, type SendInto } from './redrive';
import { PENDING_SWEEP_SECONDS, PendingMetrics, sweepPending } from './pending';
import type {
  HandleOptions,
  JobContext,
  JobHandlerFn,
  Jobs,
  OnceResult,
  QueueConfig,
  RedriveOptions,
  RedriveResult,
  ScheduleOptions,
  SendOptions,
} from './types';

export interface JobsLogger {
  warn(message: string): void;
  error(message: string): void;
}

export interface CreateJobsOptions {
  /**
   * A DEDICATED pool from `platform-db` (`createJobsPool()`, max 5). pg-boss never opens its own
   * connection, so verified TLS and the per-client error listener apply to it too. The caller owns
   * the pool and ends it after `stop()`.
   */
  pool: Pool;
  /** Defaults to `process.env`. `ROLE=worker` makes this a worker. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to `console`. */
  logger?: JobsLogger;
  /** @internal Test seam; not part of the API and not subject to semver. */
  internal?: {
    superviseIntervalSeconds?: number;
    monitorIntervalSeconds?: number;
    maintenanceIntervalSeconds?: number;
    drainTimeoutMs?: number;
    pendingSweepSeconds?: number;
  };
}

interface RegisteredHandler {
  queue: ResolvedQueue;
  options: ResolvedHandler;
  fn: JobHandlerFn<object>;
}

interface ScheduledJob {
  name: string;
  cron: string;
  data: object;
  tz: string;
}

/** What goes into a job's `output` when it fails. Short on purpose: it is stored and may be read. */
const MAX_ERROR_CHARS = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

function describe(error: unknown): { name: string; message: string } {
  const e = error instanceof Error ? error : new Error(String(error));
  return { name: e.name, message: e.message.slice(0, MAX_ERROR_CHARS) };
}

/**
 * Said when `start()` is refused, with the cause in the message instead of a bare pg-boss
 * assertion: this is the first thing an engineer meets when a migration has not run.
 */
function explainStartFailure(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  let hint: string;
  if (/permission denied/i.test(message)) {
    hint =
      'The application role lacks grants on the pgboss schema. Run installJobsSchema() from the ' +
      'migration Job with the migrator role; it installs the schema and grants the application role.';
  } else if (
    /is not installed|requires migrations|schema .*does not exist|relation .* does not exist/i.test(
      message,
    )
  ) {
    hint =
      'The pgboss schema is missing or older than this version of platform-jobs. The application ' +
      'role never runs DDL: run installJobsSchema() from the migration Job with the migrator role.';
  } else {
    hint = 'See the cause.';
  }
  return new Error(`platform-jobs could not start: ${message}. ${hint}`, { cause: error });
}

export class JobsImpl implements Jobs {
  readonly role: Role;
  private readonly boss: PgBoss;
  private readonly pool: Pool;
  private readonly env: NodeJS.ProcessEnv;
  private readonly logger: JobsLogger;
  private readonly queues = new Map<string, ResolvedQueue>();
  private readonly handlers = new Map<string, RegisteredHandler>();
  private readonly schedules = new Map<string, ScheduledJob>();
  private state: 'new' | 'started' | 'stopped' = 'new';
  private purgeTimer: NodeJS.Timeout | undefined;
  private readonly queueMetrics = new QueueMetrics();
  private readonly drainTimeoutMs: number;
  private readonly pendingSweepMs: number;
  private readonly pendingMetrics = new PendingMetrics();
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(options: CreateJobsOptions) {
    this.pool = options.pool;
    this.env = options.env ?? process.env;
    this.logger = options.logger ?? console;
    this.role = roleFrom(this.env);
    const instanceName = this.env['OTEL_SERVICE_NAME']?.trim() || this.role;
    const { drainTimeoutMs, pendingSweepSeconds, ...bossInternal } = options.internal ?? {};
    this.drainTimeoutMs = drainTimeoutMs ?? DRAIN_TIMEOUT_MS;
    this.pendingSweepMs = (pendingSweepSeconds ?? PENDING_SWEEP_SECONDS) * 1000;
    this.boss = new PgBoss(
      bossOptions({
        role: this.role,
        pool: this.pool,
        instanceName,
        ...bossInternal,
      }) as ConstructorParameters<typeof PgBoss>[0],
    );
    this.boss.on('error', (error: Error) => {
      this.logger.error(`pg-boss error: ${error.message}`);
    });
    this.boss.on('warning', (warning: { message?: string }) => {
      this.logger.warn(`pg-boss warning: ${warning.message ?? JSON.stringify(warning)}`);
    });
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.state === 'started') return;
    if (this.state === 'stopped')
      throw new Error('platform-jobs was stopped and cannot be restarted.');

    try {
      await this.boss.start();
    } catch (error) {
      throw explainStartFailure(error);
    }
    this.state = 'started';

    for (const queue of this.queues.values()) await this.ensureQueue(queue);

    if (this.role === 'worker') {
      for (const handler of this.handlers.values()) await this.startWorker(handler);
      for (const schedule of this.schedules.values()) await this.applySchedule(schedule);
      this.startWorkerHousekeeping();
    }
  }

  async stop(timeoutMs: number): Promise<void> {
    if (this.state !== 'started') {
      this.state = 'stopped';
      return;
    }
    this.state = 'stopped';
    if (this.purgeTimer) clearInterval(this.purgeTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    // `close: false`: the pool is the caller's, and is ended after this returns.
    await this.boss.stop({ graceful: true, close: false, timeout: timeoutMs });
  }

  // ── queues and handlers ──────────────────────────────────────────────────────────────────

  defineQueue(queue: string, config: QueueConfig = {}): Promise<void> {
    const resolved = resolveQueue(queue, config);
    const existing = this.queues.get(queue);
    if (existing) {
      if (existing.fingerprint !== resolved.fingerprint) {
        throw new JobsConfigError(
          `Queue "${queue}" is defined twice with different configuration. A queue has one ` +
            'configuration; define it in one place.',
        );
      }
      return Promise.resolve();
    }
    this.queues.set(queue, resolved);
    // Before start() the queue is created by start(); after it, the caller may send straight away,
    // so the creation is part of what the returned promise waits for.
    return this.state === 'started' ? this.ensureQueue(resolved) : Promise.resolve();
  }

  async handle<T extends object>(
    queue: string,
    handler: JobHandlerFn<T>,
    options: HandleOptions = {},
  ): Promise<void> {
    if (this.handlers.has(queue)) {
      throw new JobsConfigError(`Queue "${queue}" already has a handler; a queue has exactly one.`);
    }
    const config: QueueConfig = { ...options };
    delete (config as HandleOptions).concurrency;
    delete (config as HandleOptions).pollingIntervalSeconds;
    const resolvedQueue = resolveQueue(queue, config);
    const resolvedHandler = resolveHandler(queue, options);
    this.defineResolved(resolvedQueue);

    const registered: RegisteredHandler = {
      queue: resolvedQueue,
      options: resolvedHandler,
      fn: handler as JobHandlerFn<object>,
    };
    this.handlers.set(queue, registered);

    if (this.state === 'started') {
      await this.ensureQueue(resolvedQueue);
      if (this.role === 'worker') await this.startWorker(registered);
    }
  }

  private defineResolved(resolved: ResolvedQueue): void {
    const existing = this.queues.get(resolved.name);
    if (existing && existing.fingerprint !== resolved.fingerprint) {
      throw new JobsConfigError(
        `Queue "${resolved.name}" is defined twice with different configuration. A queue has one ` +
          'configuration; define it in one place.',
      );
    }
    this.queues.set(resolved.name, resolved);
  }

  /**
   * Create the queue and its dead-letter queue if they are missing, and converge the options of
   * existing ones to what the code says. `createQueue` alone leaves an existing queue untouched,
   * so a changed retention would never take effect. Idempotent, and safe for the API and the
   * worker to run at the same time.
   */
  private async ensureQueue(queue: ResolvedQueue): Promise<void> {
    const dlq = queue.deadLetter;
    await this.boss.createQueue(dlq, {});
    await this.boss.updateQueue(dlq, {
      retentionSeconds: queue.deadLetterQueue.retentionSeconds,
      deleteAfterSeconds: queue.deadLetterQueue.deleteAfterSeconds,
    });

    // `partition: true` would need CREATE on the schema (F8): never used.
    await this.boss.createQueue(queue.name, { deadLetter: dlq });
    await this.boss.updateQueue(queue.name, queue.queue);
  }

  private workOptions(handler: RegisteredHandler) {
    const { options } = handler;
    return {
      pollingIntervalSeconds: options.pollingIntervalSeconds,
      // A worker with pg-boss's defaults moves ONE job per second per queue (F2): fetch a batch
      // of `concurrency`, run it together, and fetch again at once when the batch was full.
      batchSize: options.concurrency,
      localConcurrency: 1,
      burstWhenBatchFull: true,
      // Each job settles on its own: one failing job in a batch must not fail the others.
      perJobResults: true as const,
    };
  }

  private async startWorker(handler: RegisteredHandler): Promise<string> {
    return this.boss.work(handler.queue.name, this.workOptions(handler), (jobs) =>
      this.processBatch(handler, jobs),
    );
  }

  private async processBatch(handler: RegisteredHandler, jobs: BatchJob[]): Promise<BatchResult[]> {
    const outcomes = await Promise.all(jobs.map((job) => this.runOne(handler, job)));
    await this.countFailures(handler.queue.name, outcomes);
    // Only what pg-boss reads: the internal attempt number stays here.
    return outcomes.map((outcome) =>
      outcome.status === 'completed'
        ? { id: outcome.id, status: outcome.status }
        : { id: outcome.id, status: outcome.status, output: outcome.output },
    );
  }

  /**
   * `queue.failures` counts a failure only when the fenced settle that follows will land: the job is
   * still ACTIVE under the attempt that ran. A handler that throws after its claim was lost (expired,
   * cancelled, taken by another worker) is not a failure of the queue; pg-boss's fence leaves that
   * job alone, and counting it would double-count the attempt that now holds the job.
   */
  private async countFailures(queue: string, outcomes: JobOutcome[]): Promise<void> {
    const failed = outcomes.filter((o) => o.status !== 'completed');
    if (failed.length === 0) return;
    let held: Set<string> | undefined;
    try {
      const { rows } = await this.pool.query<{ id: string }>(HELD_CLAIMS_SQL, [
        queue,
        failed.map((o) => o.id),
        failed.map((o) => o.attempt),
      ]);
      held = new Set(rows.map((r) => r.id));
    } catch (error) {
      // Cannot tell: count them (the usual case) rather than lose the signal.
      this.logger.warn(
        `Could not check job claims before counting failures: ${describe(error).message}`,
      );
    }
    for (const outcome of failed) {
      if (held && !held.has(outcome.id)) {
        this.logger.warn(
          `Job ${queue}/${outcome.id} failed after its claim was lost; not counting it`,
        );
      } else {
        this.queueMetrics.recordFailure(queue);
      }
    }
  }

  /**
   * Runs one job and reports its disposition. Never throws: a throw would fail the whole batch.
   *
   * A SUCCESS IS COMPLETED HERE, at once, fenced to the attempt that was fetched. pg-boss settles a
   * batch only when every handler in it has returned, and fails every job it still holds if the
   * batch is cut off (a drain past its budget, or one job outliving the batch's lease). A job that
   * had already succeeded would be failed and retried with its side effect run again, on every
   * deploy that catches a long job. Once it is completed here, the batch-level settle finds it
   * settled and does nothing.
   */
  private async runOne(handler: RegisteredHandler, job: BatchJob): Promise<JobOutcome> {
    const queue = handler.queue.name;
    const attempt = { id: job.id, retryCount: job.retryCount };
    const context: JobContext = {
      id: job.id,
      data: job.data as object,
      attempt: job.retryCount + 1,
      signal: job.signal,
    };
    try {
      // Handler logs carry a correlation id: the one the sender put in the payload (so a job
      // continues the request that caused it), else `queue:jobId`. Never read from anywhere else.
      await withJobContext(queue, () => handler.fn(context), {
        correlationId: correlationIdFor(queue, job.id, job.data),
      });
    } catch (error) {
      const { name, message } = describe(error);
      if (isPermanent(error)) {
        this.logger.warn(
          `Job ${queue}/${job.id} failed permanently, dead-lettering: ${name}: ${message}`,
        );
        return {
          id: job.id,
          status: 'deadletter',
          output: { name, message },
          attempt: job.retryCount,
        };
      }
      this.logger.warn(
        `Job ${queue}/${job.id} attempt ${context.attempt} failed: ${name}: ${message}`,
      );
      return { id: job.id, status: 'failed', output: { name, message }, attempt: job.retryCount };
    }

    try {
      // Both calls are FENCED to the attempt that was fetched, and only match a row that is still
      // ACTIVE under it, so a handler that finishes after its claim was lost can touch nothing.
      //
      // `retention.completed: 'immediate'`: the row is DELETED instead of completed, so nothing of
      // the payload outlives its use and there is no moment when a finished row exists. (A
      // completion first would leave a row the fence can no longer match, to be deleted unfenced.)
      // The typed response is empty; the runtime answer carries `affected`, the rows it settled.
      const done = (await (handler.queue.deleteOnSuccess
        ? this.boss.deleteJob(queue, attempt)
        : this.boss.complete(queue, attempt))) as { affected?: number };
      if (done.affected === 0) {
        // Expired, cancelled or taken by another worker while the handler ran: the settle landed on
        // nothing, so this is not a processed job of this queue (the attempt that holds it counts).
        this.logger.warn(
          `Job ${queue}/${job.id} finished after its claim was lost; not completing it`,
        );
      } else {
        this.queueMetrics.recordProcessed(queue);
      }
    } catch (error) {
      // Not fatal: the batch-level settle completes it (it is fenced, so it cannot complete
      // anything that is no longer ours), and retention removes the row. The handler SUCCEEDED and
      // that settle will land, so it is a processed job: count it here, where we know.
      this.queueMetrics.recordProcessed(queue);
      this.logger.warn(`Could not settle job ${queue}/${job.id} early: ${describe(error).message}`);
    }
    return { id: job.id, status: 'completed' };
  }

  // ── send ─────────────────────────────────────────────────────────────────────────────────

  async send<T extends object>(
    queue: string,
    data: T,
    options: SendOptions = {},
  ): Promise<string | null> {
    assertQueueName(queue);
    if (data === null || typeof data !== 'object') {
      throw new JobsConfigError(`Queue "${queue}": job data must be an object.`);
    }
    if (options.priority !== undefined && !Number.isInteger(options.priority)) {
      throw new JobsConfigError(`Queue "${queue}": priority must be an integer.`);
    }
    if (options.idempotencyKey !== undefined && options.idempotencyKey.length === 0) {
      throw new JobsConfigError(`Queue "${queue}": idempotencyKey must not be empty.`);
    }
    if (this.state === 'new') {
      throw new Error(
        'platform-jobs is not started: call start() (JobsModule does) before send().',
      );
    }

    let db: ReturnType<typeof fromDrizzle> | undefined;
    if (options.tx) {
      // Imported on use: drizzle-orm is an optional peer, needed only to enqueue in a transaction.
      const { sql } = await import('drizzle-orm');
      db = fromDrizzle(
        options.tx as Parameters<typeof fromDrizzle>[0],
        sql as Parameters<typeof fromDrizzle>[1],
      );
    }

    try {
      return await this.boss.send(queue, data, {
        ...(options.idempotencyKey !== undefined
          ? { id: idempotencyId(queue, options.idempotencyKey) }
          : {}),
        ...(options.startAfter !== undefined ? { startAfter: options.startAfter } : {}),
        ...(options.priority !== undefined ? { priority: options.priority } : {}),
        ...(db ? { db } : {}),
      });
    } catch (error) {
      if (error instanceof Error && /does not exist|not found/i.test(error.message)) {
        throw new Error(
          `${error.message} Queue "${queue}" is not defined: call jobs.handle() or jobs.defineQueue() ` +
            'for it in this process before start().',
          { cause: error },
        );
      }
      throw error;
    }
  }

  // ── schedules ────────────────────────────────────────────────────────────────────────────

  async schedule(
    name: string,
    cron: string,
    data: object = {},
    options: ScheduleOptions = {},
  ): Promise<void> {
    assertQueueName(name);
    if (cron.trim().split(/\s+/).length < 5) {
      throw new JobsConfigError(
        `Schedule "${name}": "${cron}" is not a cron expression (5 fields).`,
      );
    }
    const tz = options.tz ?? DEFAULT_TIME_ZONE;
    assertTimeZone(tz);
    if (this.schedules.has(name)) {
      throw new JobsConfigError(
        `Schedule "${name}" is already registered; a queue has one schedule.`,
      );
    }

    // The schedule's job lands on a queue named like the schedule; make sure it exists.
    if (!this.queues.has(name)) this.defineResolved(resolveQueue(name));

    const schedule: ScheduledJob = { name, cron, data, tz };
    this.schedules.set(name, schedule);
    if (this.state === 'started' && this.role === 'worker') {
      await this.ensureQueue(this.queues.get(name)!);
      await this.applySchedule(schedule);
    }
  }

  private async applySchedule(schedule: ScheduledJob): Promise<void> {
    await this.boss.schedule(schedule.name, schedule.cron, schedule.data, { tz: schedule.tz });
  }

  // ── redrive ──────────────────────────────────────────────────────────────────────────────

  redrive(dlq: string, options: RedriveOptions = {}): Promise<RedriveResult> {
    assertQueueName(dlq);
    if (this.state !== 'started') {
      return Promise.reject(
        new Error('platform-jobs is not started: call start() before redrive().'),
      );
    }
    return redriveDeadLetters(
      {
        pool: this.pool,
        warn: (message) => this.logger.warn(message),
        policyFor: (origin) => {
          const queue = this.queues.get(origin);
          return queue === undefined ? undefined : (queue.canRedrive ?? null);
        },
        send: ((queue, data, sendOptions) =>
          this.boss.send(queue, data, sendOptions as never)) as SendInto,
      },
      dlq,
      options,
    );
  }

  // ── once ─────────────────────────────────────────────────────────────────────────────────

  async once<T>(
    db: DbExecutor,
    key: string,
    effect: (tx: DbExecutor) => Promise<T>,
  ): Promise<OnceResult<T>> {
    if (key.length === 0) throw new JobsConfigError('once(): key must not be empty.');
    // Imported on use: both are optional at the package level.
    const { sql } = await import('drizzle-orm');
    const { withTransaction } = await import('@quynhonsemiconductor/platform-db/drizzle');

    return withTransaction(db, (outer) =>
      // A SAVEPOINT around marker AND effect. If `effect` throws and the caller catches it and
      // commits, the marker and the effect's partial writes roll back together; without it the
      // marker would commit with half an effect and every later delivery would skip it.
      (outer as unknown as SavepointCapable).transaction(async (tx): Promise<OnceResult<T>> => {
        const claimed = await tx.execute(
          sql`INSERT INTO ${sql.raw(EFFECT_TABLE)} (key) VALUES (${key}) ON CONFLICT (key) DO NOTHING RETURNING key`,
        );
        if (rowsOf(claimed).length === 0) return { ran: false };
        return { ran: true, value: await effect(tx as unknown as DbExecutor) };
      }),
    );
  }

  private startWorkerHousekeeping(): void {
    registerOldestReadyAge(
      this.pool,
      () => [...this.queues.keys()],
      (error) =>
        this.logger.warn(`Could not read the oldest ready job age: ${describe(error).message}`),
    );

    // Watch the queues that set `retention.pending`: delete what waited past its deadline ourselves
    // (the same deletion pg-boss does, silently, every 15 minutes) so that the loss is reported.
    const sweep = async () => {
      const watched = [...this.queues.values()].filter((q) => q.pendingWatch).map((q) => q.name);
      try {
        for (const [queue, count] of await sweepPending(this.pool, watched)) {
          this.pendingMetrics.record(queue, count);
          const window = this.queues.get(queue)?.queue.retentionSeconds;
          this.logger.warn(
            `${count} job${count === 1 ? '' : 's'} on "${queue}" waited past retention.pending (${window} s) ` +
              'without being processed and ' +
              (count === 1 ? 'was' : 'were') +
              ' deleted',
          );
        }
      } catch (error) {
        this.logger.warn(`Could not sweep unprocessed jobs: ${describe(error).message}`);
      }
    };
    // Once at once, before the interval: after an outage the backlog of expired jobs is already
    // there, and pg-boss's own first pass (about 15 s after start) would delete it silently.
    void sweep();
    this.sweepTimer = setInterval(() => void sweep(), this.pendingSweepMs);
    this.sweepTimer.unref();

    const purge = async () => {
      try {
        await this.pool.query(
          `DELETE FROM ${EFFECT_TABLE} WHERE done_at < now() - make_interval(days => $1)`,
          [DEFAULTS.onceRetentionDays],
        );
      } catch (error) {
        this.logger.warn(`Could not purge old jobs.once markers: ${describe(error).message}`);
      }
    };
    void purge();
    this.purgeTimer = setInterval(() => void purge(), DAY_MS);
    this.purgeTimer.unref();
  }

  // ── for @quynhonsemiconductor/platform-jobs/testing ──────────────────────────────────────

  /** @internal */
  handlerFor(queue: string): RegisteredHandler | undefined {
    return this.handlers.get(queue);
  }

  /**
   * @internal Process every job that is ready on `queue`, through a real pg-boss worker running
   * the SAME batch path as production (a real `AbortSignal`, the failure output a worker stores,
   * `PermanentJobError` dead-lettering, retention), and resolve when nothing is ready or active.
   * Rejects with the first handler error, after the batch has settled.
   */
  async drain(queue: string): Promise<void> {
    const handler = this.handlers.get(queue);
    if (!handler)
      throw new Error(`No handler is registered for queue "${queue}": call jobs.handle() first.`);
    if (this.state !== 'started')
      throw new Error('platform-jobs is not started: call start() first.');

    const failures: string[] = [];
    const worker = await this.boss.work(queue, this.workOptions(handler), async (jobs) => {
      const outcomes = await this.processBatch(handler, jobs);
      for (const outcome of outcomes) {
        if (outcome.status !== 'completed') {
          failures.push((outcome.output as { message?: string } | undefined)?.message ?? 'error');
        }
      }
      return outcomes;
    });
    let quiet = 0;
    try {
      for (let waited = 0; quiet < 2 && waited < this.drainTimeoutMs; waited += DRAIN_POLL_MS) {
        await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
        const { rows } = await this.pool.query<{ n: string }>(
          `SELECT count(*) AS n FROM pgboss.job
            WHERE name = $1 AND state IN ('created', 'retry', 'active') AND NOT blocked AND start_after <= now()`,
          [queue],
        );
        quiet = Number(rows[0]!.n) === 0 ? quiet + 1 : 0;
      }
    } finally {
      // Wait for the worker's current job only when the queue went quiet; on a timeout a handler may
      // never return, and waiting for it would hang the very test this is reporting for.
      await this.boss.offWork(queue, { id: worker, wait: quiet >= 2 });
    }
    if (quiet < 2) {
      throw new Error(
        `drainQueue: queue "${queue}" still had ready or active jobs after ${this.drainTimeoutMs} ms; ` +
          'a handler is not finishing (or keeps enqueuing work for the same queue).',
      );
    }
    if (failures.length > 0) {
      throw new Error(`Job on queue "${queue}" failed: ${failures[0]}`);
    }
  }
}

const DRAIN_POLL_MS = 100;
const DRAIN_TIMEOUT_MS = 60_000;

interface BatchJob {
  id: string;
  data: unknown;
  retryCount: number;
  signal: AbortSignal;
}

/** What pg-boss reads from a `perJobResults` handler. */
interface BatchResult {
  id: string;
  status: 'completed' | 'failed' | 'deadletter';
  output?: object;
}

type JobOutcome =
  | { id: string; status: 'completed' }
  | { id: string; status: 'failed' | 'deadletter'; output: object; attempt: number };

/** Drizzle's transaction exposes `transaction()`, which nests as a savepoint. */
interface SavepointCapable {
  transaction<R>(
    fn: (tx: DbExecutor & { execute(query: unknown): Promise<unknown> }) => Promise<R>,
  ): Promise<R>;
}

function rowsOf(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  const rows = (result as { rows?: unknown[] } | null)?.rows;
  return rows ?? [];
}

export function createJobs(options: CreateJobsOptions): Jobs {
  return new JobsImpl(options);
}

import type { DbExecutor } from '@quynhonsemiconductor/platform-db/drizzle';

/**
 * The public types of this package. NOTHING here (or anywhere in the published declarations)
 * names a `pg-boss` type: its own `.d.ts` does not compile under this repo's `moduleResolution`
 * without `skipLibCheck` (ADR 0001, F11, decision 7), and a product must never depend on it.
 */

/** What a handler receives for one job. */
export interface JobContext<T extends object = object> {
  /** The job id. With an `idempotencyKey` it is the deterministic UUID derived from it. */
  id: string;
  data: T;
  /** 1 for the first run, 2 for the first retry, and so on. */
  attempt: number;
  /**
   * Aborted when the worker is shutting down past its budget, or when the job's claim is lost
   * (its lease or heartbeat lapsed and another worker may now run it). Stop work and throw.
   * Note that it is also aborted after an ORDINARY completion: do not treat "aborted" as failure
   * in a `finally`.
   */
  signal: AbortSignal;
}

export type JobHandlerFn<T extends object = object> = (job: JobContext<T>) => Promise<void>;

/**
 * How long finished jobs stay in the database. Seconds, except `completed: 'immediate'`.
 *
 * pg-boss keeps every FINISHED job of a queue (completed, and failed after its retries) on one
 * clock, so `completed` and `failed` cannot differ by number. Either give one of them (the other
 * follows), give the same number to both, or use `completed: 'immediate'` to delete a job the
 * moment its handler succeeds and keep failures for `failed` seconds (the case that matters:
 * a payload that should not linger once it has been used, but a failure someone must be able to
 * read).
 */
export interface RetentionOptions {
  /** Default 7 days. `'immediate'`: the row is deleted as soon as the handler succeeds. */
  completed?: number | 'immediate';
  /** Jobs that exhausted their retries stay in their queue this long. Default: follows `completed`, or 7 days. */
  failed?: number;
  /**
   * How long a dead-letter copy waits to be handled or redriven before it is deleted.
   * Default 30 days. This is where a failure's payload and error are kept (the original row follows
   * `completed`), so it is also how long failed data lingers: keep it short for personal data.
   * Alert on the dead-letter queue's depth rather than relying on this.
   */
  deadLetter?: number;
}

/** How a queue behaves. Every field is optional; the defaults are in `DEFAULTS` and the README. */
export interface QueueConfig {
  /** Ceiling on a job's run time, in seconds (not a recovery time). Default 900. */
  expireInSeconds?: number;
  /**
   * Worker liveness interval. Default 30 when `expireInSeconds` > 300, otherwise off. Minimum 10.
   * With it, a job whose worker died is recovered within about a heartbeat instead of at the
   * end of `expireInSeconds`.
   */
  heartbeatSeconds?: number;
  /** Retries after the first run. Default 3, minimum 1 (see `acceptDeadLetterOnDrain`). */
  retryLimit?: number;
  /**
   * `retryLimit: 0` is refused unless this is `true`. A pod drain that interrupts a job costs it
   * one attempt, so with no retry left the job goes straight to the dead-letter queue and no
   * other worker runs it (ADR 0001, F5). Declaring it means you accept that.
   */
  acceptDeadLetterOnDrain?: boolean;
  /** Initial delay between retries, seconds; grows with exponential backoff. Default 5. */
  retryDelaySeconds?: number;
  /** Upper bound of the backoff, seconds. Default 300. */
  retryDelayMaxSeconds?: number;
  /** Dead-letter queue. Default `${queue}.dlq`, created for you. */
  deadLetter?: string;
  retention?: RetentionOptions;
}

export interface HandleOptions extends QueueConfig {
  /**
   * Jobs this process runs at once for the queue. Default 4. They are fetched together as one
   * batch (the next fetch happens when the whole batch has finished), which is what lets a worker
   * keep up with more than one job per second (ADR 0001, F2).
   */
  concurrency?: number;
  /** Seconds between fetches on an idle queue. Default 1, minimum 0.5. */
  pollingIntervalSeconds?: number;
}

export interface SendOptions {
  /**
   * The root database or an open transaction from `platform-db`. The job commits and rolls back
   * with it: roll back and there is no job.
   */
  tx?: DbExecutor;
  /**
   * Deduplicates: a second `send` with the same key on the same queue inserts nothing and returns
   * `null`. Mapped to a deterministic UUIDv5 used as the job id, so it holds while the job row
   * exists (its retention); a handler that must never act twice still needs its own guard
   * (`jobs.once`).
   */
  idempotencyKey?: string;
  /** Seconds from now, or a date. */
  startAfter?: Date | number;
  /** Higher runs first. Default 0. */
  priority?: number;
}

export interface ScheduleOptions {
  /** IANA time zone the cron expression is read in. Default `Asia/Ho_Chi_Minh`. */
  tz?: string;
}

export type OnceResult<T> = { ran: true; value: T } | { ran: false };

export interface Jobs {
  /**
   * Connects pg-boss. Throws, naming the cause, if the `pgboss` schema is missing or older than
   * this code: the application role never runs DDL, the migration Job installs the schema
   * (`installJobsSchema`). With `ROLE=worker` it also registers the handlers, starts the
   * supervisor and registers the schedules; without it, it can only enqueue.
   */
  start(): Promise<void>;
  /**
   * Graceful: stop fetching, wait up to `timeoutMs` for active jobs, then fail the rest (which
   * spends one retry of each). Called by the shutdown hook in `beforeApplicationShutdown`.
   */
  stop(timeoutMs: number): Promise<void>;

  /**
   * Resolves to the job id, or `null` when `idempotencyKey` matched an existing job.
   *
   * With `tx` the job is written on that transaction. WITHOUT it, `send` commits on the jobs
   * pool's own connection, immediately and independently of any transaction you have open: a
   * business write you roll back afterwards does not take the job with it. Pass `tx` whenever the
   * job belongs to a business write.
   */
  send<T extends object>(queue: string, data: T, options?: SendOptions): Promise<string | null>;

  /**
   * Declares a queue without a handler, for a process that only enqueues to it. `handle()` does
   * this for you. Calling it twice with different configuration throws (synchronously).
   *
   * Resolves when the queue exists in the database: immediate before `start()` (it is created
   * then), and after the creation when called once started. Await it if you `send` straight after.
   */
  defineQueue(queue: string, config?: QueueConfig): Promise<void>;

  /**
   * Registers a handler. The queue is defined in every process, but the handler RUNS only when
   * `ROLE=worker`; in any other process this only records the queue so `send` works.
   */
  handle<T extends object>(
    queue: string,
    handler: JobHandlerFn<T>,
    options?: HandleOptions,
  ): Promise<void>;

  /**
   * Runs `name` with `data` on a cron schedule, once per tick across all replicas. Only a
   * `ROLE=worker` process registers it. The queue is `name`; give it a `handle()`.
   */
  schedule(name: string, cron: string, data?: object, options?: ScheduleOptions): Promise<void>;

  /**
   * Run a DATABASE effect at most once per `key`, however many times a job is delivered (jobs are
   * at-least-once). The marker row and `effect`'s writes share ONE transaction (the caller's if
   * `db` is a transaction), inside a SAVEPOINT: if `effect` throws, its partial writes AND the
   * marker are rolled back even when the caller catches the error and commits, so a later delivery
   * runs it again.
   *
   * **NEVER put an external call in `effect`** (an email, an HTTP request, an LLM). It holds a
   * database transaction and the marker's row lock for as long as it runs, which is exactly what
   * PLAN §4.3 forbids, and it cannot be made atomic with the marker anyway. An external effect
   * needs its own claim ledger (claim, call with the provider's idempotency key, record the
   * outcome), as `platform-mail` does.
   *
   * `key` is global to the database: prefix it with the queue or the domain
   * (`invoice.render:${job.id}`), or two features that both use `job.id` will skip each other.
   * Markers are kept 30 days.
   */
  once<T>(
    db: DbExecutor,
    key: string,
    effect: (tx: DbExecutor) => Promise<T>,
  ): Promise<OnceResult<T>>;
}

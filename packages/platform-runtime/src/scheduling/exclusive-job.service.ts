import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { CacheService } from '@quynhonsemiconductor/platform-cache';
import { getMeter, JobMetrics, withJobContext } from '@quynhonsemiconductor/observability';

/**
 * Where `@quynhonsemiconductor/platform-db/nest` registers its pool. A `Symbol.for` registry
 * symbol so this package finds it without importing platform-db, which is an optional peer here.
 */
const DATABASE_POOL_TOKEN = Symbol.for('@quynhonsemiconductor/platform-db:pool');

/**
 * Runs that went ahead with NO leader lock at all (no cache and no database pool). Alert on
 * `rate(job.unlocked_runs) > 0` in a multi-replica deployment: it means every replica is running
 * this job.
 *
 * Owned here rather than as a `JobMetrics` outcome: `JobMetrics.record`'s outcome is typed
 * `'success' | 'failure'` in `observability`, and a third value belongs in that package. When it
 * gains one, this moves there.
 */
const UNLOCKED_RUNS = 'job.unlocked_runs';

/**
 * ExclusiveJob — run a scheduled job on exactly one pod, with a correlation id and
 * duration/outcome metrics.
 *
 * @deprecated Use `platform-jobs` schedules (`jobs.schedule(name, cron, data)`): pg-boss runs a
 * singleton schedule once per tick in the product's own database, with retries and dead-letter,
 * which this helper cannot offer. Kept for the products that still use `@Cron`; removal is
 * planned for the next `platform-runtime` major, after every product has converged (WP-15).
 *
 * WHY THIS EXISTS
 * ---------------
 * `@Cron` and `@Interval` fire on EVERY replica. With one worker replica that is invisible;
 * the moment a rolling deploy overlaps two replicas, or the worker scales past one, every job
 * runs twice concurrently. That is not academic here: `audit-cleanup` deletes rows and
 * `storage-cleanup` deletes objects. `@Interval` is the worse of the two, because interval
 * timers start when the pod starts and therefore drift independently — two pods never even
 * collide predictably enough to notice in a log.
 *
 * A SERVICE, NOT A COPIED BLOCK: the lock/log/finally/metrics sequence is identical for
 * every job, and there are eight of them. Inlining it would be eight chances to forget the
 * `finally` and leave a lock held for its whole TTL.
 *
 * WITHOUT A CACHE, THE LOCK MOVES TO POSTGRES. `CacheService.acquireLock` returns `false` both
 * when another pod holds the lock AND when there is no cache client at all, so treating a
 * false as "someone else has it" means a Valkey outage silently stops every scheduled job in
 * the system while logging that another pod is doing the work. So when the cache is not
 * available the job takes a Postgres advisory lock instead (`withAdvisoryLock` from
 * `platform-db`): a tick still runs once across replicas, and a crashed holder frees the lock
 * the moment its connection drops. It needs no Valkey, only the database the product has anyway.
 *
 * Only when there is NEITHER a cache NOR a database pool does it fail OPEN and run the job
 * unlocked, logging at ERROR and counting it in `job.unlocked_runs`. Leader election is then impossible, and losing SLA-breach
 * detection for the length of an incident is worse than running a sweep twice: every job
 * behind this helper is idempotent (deletes filter on age or orphan status, syncs re-read
 * from the source).
 *
 * KNOWN LIMIT: if the cache is down for ONE pod only (its own connection flapping) while
 * another pod still holds a cache lock, the two use different locks and may overlap. That is
 * strictly narrower than the old behaviour, where every pod with a flapping cache ran unlocked.
 */
@Injectable()
export class ExclusiveJob {
  private readonly logger = new Logger(ExclusiveJob.name);

  /**
   * Constructed directly rather than injected, matching `AbstractOutboxRelay`. The OTel
   * instruments are process-global (the same name returns the same instrument) and
   * JobMetrics has no dependencies, so there is nothing for DI to provide.
   */
  private readonly jobMetrics = new JobMetrics();

  private readonly unlockedRuns = getMeter().createCounter(UNLOCKED_RUNS, {
    description: 'Scheduled job runs that went ahead with no leader lock (no cache, no database)',
  });

  /**
   * In-process overlap guard, held alongside the distributed lock rather than instead of it.
   * The two cover different failures: the cache lock stops a SECOND POD starting the job,
   * this stops THIS pod starting a second run when the previous one is still going. It also
   * remains the only guard on the fail-open path below, where there is no cache to lock in.
   */
  private readonly running = new Set<string>();

  // Token named explicitly — see the note in `TypedConfigService`. A bare parameter
  // annotation reads as a type-only import to `consistent-type-imports`, and taking
  // that advice would erase `CacheService` at runtime and break injection silently.
  // This is the one deviation from the file as it stood in `rova`/`opshub`.
  constructor(
    @Inject(CacheService) private readonly cache: CacheService,
    // Provided by `DatabaseModule` from `platform-db/nest`; absent in a product without it.
    @Optional() @Inject(DATABASE_POOL_TOKEN) private readonly pool?: object,
  ) {}

  /**
   * Run `fn` under a cluster-wide lock named after the job.
   *
   * @param name       Job name. Becomes the lock key, the metric label and the log
   *                   correlation scope, so it must be stable — renaming it mid-deploy
   *                   means two differently-named locks and no mutual exclusion.
   * @param lockTtlMs  Lock lifetime. Set it just UNDER the schedule interval: long enough
   *                   that a slow run keeps its lock, short enough that a pod killed
   *                   mid-run does not block the next tick. The lock auto-expires, so a
   *                   crash can never deadlock the job permanently.
   */
  async run(name: string, lockTtlMs: number, fn: () => Promise<void>): Promise<void> {
    if (this.running.has(name)) {
      this.logger.warn(`${name} still running from a previous tick on this pod — skipping`);
      return;
    }
    this.running.add(name);
    try {
      // withJobContext gives the run a correlationId — scheduled work has no request to
      // inherit one from, so without this every line a job logs is unattributable.
      await withJobContext(name, () =>
        this.jobMetrics.time(name, () => this.runExclusively(name, lockTtlMs, fn)),
      );
    } finally {
      this.running.delete(name);
    }
  }

  private async runExclusively(name: string, lockTtlMs: number, fn: () => Promise<void>) {
    if (!this.cache.isAvailable) {
      await this.runWithoutCache(name, fn);
      return;
    }

    const key = `cron:${name}`;
    if (!(await this.cache.acquireLock(key, lockTtlMs))) {
      this.logger.log(`${name} already running on another pod — skipping this tick`);
      return;
    }

    try {
      await fn();
    } finally {
      // In `finally` so a throwing job releases its lock rather than blocking every tick
      // until the TTL expires.
      await this.cache.releaseLock(key);
    }
  }

  /** The cache is down or was never configured: elect through Postgres if there is one. */
  private async runWithoutCache(name: string, fn: () => Promise<void>): Promise<void> {
    if (!this.pool) {
      // ERROR, not warn, and counted: with more than one replica this is every replica running
      // the job, which is a defect to be alerted on rather than a note in the log.
      this.logger.error(
        `Cache unavailable and no database pool — running ${name} WITHOUT a leader lock (unlocked). ` +
          `Safe on a single replica; with more than one, EVERY replica runs it. Configure a cache ` +
          `or platform-db.`,
      );
      this.unlockedRuns.add(1, { job: name });
      await fn();
      return;
    }

    // Imported on use: platform-db is an optional peer, and this file must load without it.
    const { withAdvisoryLock } = await import('@quynhonsemiconductor/platform-db');
    const result = await withAdvisoryLock(
      this.pool as Parameters<typeof withAdvisoryLock>[0],
      `cron:${name}`,
      fn,
    );
    if (!result.acquired) {
      this.logger.log(
        `${name} already running on another pod (advisory lock) — skipping this tick`,
      );
    }
  }
}

/**
 * `@quynhonsemiconductor/platform-jobs`
 *
 * Durable jobs on Postgres and pg-boss: enqueue in the business transaction (roll back and there
 * is no job), at-least-once delivery with retries and a dead-letter queue, schedules that run
 * once per tick across replicas, and a graceful stop.
 *
 * Products never import `pg-boss`. Nothing in this package's published types names it.
 *
 * Subpaths:
 *   `@quynhonsemiconductor/platform-jobs/nest`     JobsModule, @JobHandler
 *   `@quynhonsemiconductor/platform-jobs/testing`  drainQueue, runInline
 */
export { createJobs, type CreateJobsOptions, type JobsLogger } from './engine';
export { createJobsPool } from './pool';
export { installJobsSchema, jobsGrantsSql, type InstallJobsSchemaOptions } from './install';
export { stopBudgetMs } from './budget';
export { roleFrom, type Role } from './boss-options';
export { DEFAULTS, DEFAULT_TIME_ZONE, JobsConfigError } from './config';
export { PermanentJobError } from './errors';
export { idempotencyId } from './idempotency';
export { OLDEST_READY_AGE_METRIC } from './metrics';
export type {
  HandleOptions,
  JobContext,
  JobHandlerFn,
  Jobs,
  OnceResult,
  QueueConfig,
  RetentionOptions,
  ScheduleOptions,
  SendOptions,
} from './types';

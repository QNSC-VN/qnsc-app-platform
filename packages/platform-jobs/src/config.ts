import type { HandleOptions, QueueConfig, RetentionOptions } from './types';

const MINUTE = 60;
const DAY = 24 * 60 * MINUTE;

/**
 * The defaults, in one place. They are STARTING POINTS chosen from the WP-6 findings (ADR 0001),
 * not measured optima, and are re-tuned after the first month on the server. Each is overridable
 * per queue; the README gives the reason for every one.
 */
export const DEFAULTS = {
  /** Jobs in flight per queue per process. Fetched as one batch of this size (F2). */
  concurrency: 4,
  /** A user waiting for an OTP is "picked up within ~1 s": p95 989 ms at 1 s (F1). */
  pollingIntervalSeconds: 1,
  /** Below this the polling cost (about 2 transactions per second per queue) buys nothing. */
  minPollingIntervalSeconds: 0.5,
  /** pg-boss's own default; a ceiling on run time, not a recovery time (F4). */
  expireInSeconds: 900,
  /** Jobs longer than this get a heartbeat, so a dead worker is noticed in ~30 s (F4). */
  heartbeatAboveExpireSeconds: 300,
  heartbeatSeconds: 30,
  /** pg-boss refuses less. */
  minHeartbeatSeconds: 10,
  /** Three retries: a transient outage of a provider is covered, a bug is not retried forever. */
  retryLimit: 3,
  /** A pod drain spends one attempt (F5), so a queue always keeps one in hand unless it opts out. */
  minRetryLimit: 1,
  retryDelaySeconds: 5,
  /** Exponential backoff from 5 s reaches this after about six retries. */
  retryDelayMaxSeconds: 300,
  retention: {
    completed: 7 * DAY,
    /**
     * How long a dead-letter copy waits to be handled or redriven. pg-boss deletes a waiting job at
     * keep_until, so "until handled" cannot be literal. 30 days is the failure retention the plan
     * asks for, carried by the dead-letter copy because pg-boss keeps finished jobs on one clock
     * (ADR 0001, amendment 2026-10-10), and it bounds how long a failed payload (personal data)
     * lingers. Alert on the dead-letter queue's depth; do not rely on this to "keep until handled".
     */
    deadLetter: 30 * DAY,
  },
  /** Queue counts behind the depth gauge are only as fresh as this (F10). */
  superviseIntervalSeconds: 15,
  /**
   * How often finished jobs past their retention are deleted. pg-boss's default is 24 HOURS, which
   * would turn "failed jobs are kept at most 24 h" into up to 48 h (ADR 0001 decision 3). A
   * deletion pass is one indexed DELETE per queue, so 15 minutes costs nothing.
   */
  maintenanceIntervalSeconds: 900,
  /** The dedicated pool: pg-boss queries are short, and it must not starve the API's own pool. */
  poolMax: 5,
  /** How long a `jobs.once` marker is kept. */
  onceRetentionDays: 30,
} as const;

export const DEFAULT_TIME_ZONE = 'Asia/Ho_Chi_Minh';

export class JobsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobsConfigError';
  }
}

const QUEUE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.\-/]{0,99}$/;

export function assertQueueName(name: string): void {
  if (!QUEUE_NAME.test(name)) {
    throw new JobsConfigError(
      `Queue name "${name}" is not valid: use 1-100 letters, digits, "_", ".", "-" or "/", starting with a letter or digit.`,
    );
  }
}

function integer(queue: string, field: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new JobsConfigError(
      `Queue "${queue}": ${field} must be an integer between ${min} and ${max}, received ${value}.`,
    );
  }
  return value;
}

/** What a queue's configuration comes to in pg-boss terms. Internal: pg-boss types stay out of it. */
export interface ResolvedQueue {
  name: string;
  deadLetter: string;
  /** Options for the queue itself. */
  queue: {
    expireInSeconds: number;
    heartbeatSeconds: number | null;
    retryLimit: number;
    retryDelay: number;
    retryBackoff: true;
    retryDelayMax: number;
    deleteAfterSeconds: number;
    deadLetter: string;
  };
  /** Options for its dead-letter queue. */
  deadLetterQueue: { retentionSeconds: number; deleteAfterSeconds: number };
  /** Delete a job's row as soon as its handler succeeds (`retention.completed: 'immediate'`). */
  deleteOnSuccess: boolean;
  /** The configuration as given, normalised, for comparing two definitions of one queue. */
  fingerprint: string;
}

export interface ResolvedHandler {
  concurrency: number;
  pollingIntervalSeconds: number;
}

export function resolveRetention(
  queue: string,
  retention: RetentionOptions = {},
): { deleteOnSuccess: boolean; finishedSeconds: number; deadLetterSeconds: number } {
  const { completed, failed, deadLetter } = retention;
  if (completed !== undefined && completed !== 'immediate') {
    integer(queue, 'retention.completed', completed, 1, 3650 * DAY);
  }
  if (failed !== undefined) integer(queue, 'retention.failed', failed, 1, 3650 * DAY);
  const deadLetterSeconds =
    deadLetter === undefined
      ? DEFAULTS.retention.deadLetter
      : integer(queue, 'retention.deadLetter', deadLetter, 1, 3650 * DAY);

  if (completed === 'immediate') {
    return {
      deleteOnSuccess: true,
      // The rows that remain are failures; they live for `failed`.
      finishedSeconds: failed ?? DEFAULTS.retention.completed,
      deadLetterSeconds,
    };
  }

  if (typeof completed === 'number' && failed !== undefined && failed !== completed) {
    throw new JobsConfigError(
      `Queue "${queue}": retention.completed (${completed}) and retention.failed (${failed}) differ. ` +
        'pg-boss deletes every finished job of a queue on one clock. Give both the same number, ' +
        "give only one (the other follows), or use retention.completed: 'immediate' to delete " +
        'successes at once and keep failures for retention.failed.',
    );
  }
  return {
    deleteOnSuccess: false,
    finishedSeconds:
      (typeof completed === 'number' ? completed : failed) ?? DEFAULTS.retention.completed,
    deadLetterSeconds,
  };
}

export function resolveQueue(name: string, config: QueueConfig = {}): ResolvedQueue {
  assertQueueName(name);

  const expireInSeconds = integer(
    name,
    'expireInSeconds',
    config.expireInSeconds ?? DEFAULTS.expireInSeconds,
    1,
    7 * DAY,
  );

  let heartbeatSeconds: number | null = null;
  if (config.heartbeatSeconds !== undefined) {
    heartbeatSeconds = integer(
      name,
      'heartbeatSeconds',
      config.heartbeatSeconds,
      DEFAULTS.minHeartbeatSeconds,
      DAY,
    );
  } else if (expireInSeconds > DEFAULTS.heartbeatAboveExpireSeconds) {
    heartbeatSeconds = DEFAULTS.heartbeatSeconds;
  }

  const retryLimit = config.retryLimit ?? DEFAULTS.retryLimit;
  integer(name, 'retryLimit', retryLimit, 0, 100);
  if (retryLimit < DEFAULTS.minRetryLimit && config.acceptDeadLetterOnDrain !== true) {
    throw new JobsConfigError(
      `Queue "${name}": retryLimit ${retryLimit} is below the minimum of ${DEFAULTS.minRetryLimit}. ` +
        'A pod drain that interrupts a job spends one attempt, so with none left the job goes ' +
        'straight to the dead-letter queue and no other worker runs it. If this queue must never ' +
        'retry, say so with acceptDeadLetterOnDrain: true.',
    );
  }

  const retryDelay = integer(
    name,
    'retryDelaySeconds',
    config.retryDelaySeconds ?? DEFAULTS.retryDelaySeconds,
    1,
    DAY,
  );
  const retryDelayMax = integer(
    name,
    'retryDelayMaxSeconds',
    config.retryDelayMaxSeconds ?? DEFAULTS.retryDelayMaxSeconds,
    retryDelay,
    7 * DAY,
  );

  const deadLetter = config.deadLetter ?? `${name}.dlq`;
  if (config.deadLetter === undefined && !QUEUE_NAME.test(deadLetter)) {
    // Not the queue's own fault in the message: say what the default dead-letter name is and how out.
    throw new JobsConfigError(
      `Queue "${name}": its default dead-letter queue "${deadLetter}" would be longer than 100 characters. ` +
        'Use a queue name of at most 96 characters, or name the dead-letter queue with `deadLetter`.',
    );
  }
  assertQueueName(deadLetter);
  if (deadLetter === name) {
    throw new JobsConfigError(`Queue "${name}": its dead-letter queue cannot be itself.`);
  }

  const { deleteOnSuccess, finishedSeconds, deadLetterSeconds } = resolveRetention(
    name,
    config.retention,
  );

  const resolved: Omit<ResolvedQueue, 'fingerprint'> = {
    name,
    deadLetter,
    queue: {
      expireInSeconds,
      heartbeatSeconds,
      retryLimit,
      retryDelay,
      retryBackoff: true,
      retryDelayMax,
      deleteAfterSeconds: finishedSeconds,
      deadLetter,
    },
    deadLetterQueue: { retentionSeconds: deadLetterSeconds, deleteAfterSeconds: finishedSeconds },
    deleteOnSuccess,
  };
  return { ...resolved, fingerprint: JSON.stringify(resolved) };
}

export function resolveHandler(queue: string, options: HandleOptions = {}): ResolvedHandler {
  const concurrency = integer(
    queue,
    'concurrency',
    options.concurrency ?? DEFAULTS.concurrency,
    1,
    1000,
  );
  const polling = options.pollingIntervalSeconds ?? DEFAULTS.pollingIntervalSeconds;
  if (!Number.isFinite(polling) || polling < DEFAULTS.minPollingIntervalSeconds || polling > 3600) {
    throw new JobsConfigError(
      `Queue "${queue}": pollingIntervalSeconds must be between ${DEFAULTS.minPollingIntervalSeconds} and 3600, received ${polling}.`,
    );
  }
  return { concurrency, pollingIntervalSeconds: polling };
}

/** `Asia/Ho_Chi_Minh`-style zone names only; anything `Intl` cannot resolve is a typo. */
export function assertTimeZone(tz: string): void {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
  } catch {
    throw new JobsConfigError(
      `"${tz}" is not a valid IANA time zone (for example "${DEFAULT_TIME_ZONE}").`,
    );
  }
}

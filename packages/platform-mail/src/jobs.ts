import { withJobContext } from '@quynhonsemiconductor/observability';
import {
  PermanentJobError,
  type HandleOptions,
  type JobContext,
  type JobHandlerFn,
  type Jobs,
  type QueueConfig,
  type SendOptions,
} from '@quynhonsemiconductor/platform-jobs';
import { MailSendError } from './errors';
import { isCorrelationId, validateMessage, type EmailMessage, type EmailSender } from './message';
import { ledgerKey, type MailState } from './state';

/** The queue every product's mail goes through. */
export const MAIL_QUEUE = 'mail.send';

/**
 * The ONE definition of the `mail.send` queue. The worker registers its handler with it and every
 * other process (an API pod that only enqueues, identity's auth mail) defines the queue with it,
 * so they cannot disagree — `platform-jobs` throws when one queue is defined twice differently.
 *
 * - **Redrive.** `canRedrive` forbids redriving `auth.*` dead letters ({@link mailCanRedrive}).
 * - **Retention.** Auth emails carry bearer links (verification, password reset) in clear in the
 *   job payload, so a completed job is deleted at once, and a failed or dead-lettered one is kept
 *   at most 24 h (ADR 0001 decision 3; identity ADR 0002 decision 4).
 * - **Lease and heartbeat.** `expireInSeconds` is the ceiling on one attempt, including its wait
 *   for a send slot. A 30 s heartbeat recovers a killed worker's job in about a heartbeat plus the
 *   monitor pass instead of at the end of the lease (ADR 0001 F4, amendment 3).
 * - **Retries.** At least 1, because a pod drain costs the interrupted job one attempt (decision 4).
 *   `retryLimit` × the backoff gives a retry window of AT LEAST an hour (see
 *   {@link minRetryWindowSeconds}): a ten-minute Valkey outage, or sustained throttling, must not
 *   dead-letter a password-reset email. Transient failures wait it out; permanent ones skip it
 *   ({@link PermanentJobError}).
 */
export const MAIL_QUEUE_CONFIG = Object.freeze({
  expireInSeconds: 300,
  heartbeatSeconds: 30,
  retryLimit: 10,
  retryDelaySeconds: 10,
  retryDelayMaxSeconds: 900,
  retention: Object.freeze({ completed: 'immediate', failed: 86_400, deadLetter: 86_400 }),
  // Authentication mail is never redriven (see {@link mailCanRedrive}). Not stored in the database:
  // every process that may redrive defines the queue from this object, as the enqueue-only
  // `createMailQueue` does, and `platform-jobs` refuses two definitions that disagree on having one.
  canRedrive: mailCanRedrive,
} satisfies QueueConfig);

/**
 * What the worker adds: one send at a time (the mailbox is paced to a few a minute, so
 * parallelism buys nothing, and a job waiting for its slot should hold one slot of the worker),
 * polled every second so an OTP is picked up within about a second.
 */
export const MAIL_HANDLE_OPTIONS: Readonly<HandleOptions> = Object.freeze({
  ...MAIL_QUEUE_CONFIG,
  concurrency: 1,
  pollingIntervalSeconds: 1,
});

/**
 * The shortest time `retryLimit` retries span, in seconds. pg-boss waits
 * `min(max, delay × 2ⁿ × (1 + random))` before retry n+1 (n from 0); `random` can be 0, so the
 * guaranteed window uses `delay × 2ⁿ`.
 */
export function minRetryWindowSeconds(config: QueueConfig = MAIL_QUEUE_CONFIG): number {
  const limit = config.retryLimit ?? 0;
  const delay = config.retryDelaySeconds ?? 0;
  const max = config.retryDelayMaxSeconds ?? delay;
  let total = 0;
  for (let n = 0; n < limit; n += 1) total += Math.min(max, delay * 2 ** n);
  return total;
}

/**
 * How long one attempt's ledger claim lasts without being renewed, and how often a LIVE attempt
 * renews it (twice per lease, alongside the job's own 30 s heartbeat). A worker that dies
 * mid-send stops renewing, so its claim lapses within one lease (~60 s) — not at the end of the
 * job's five-minute ceiling — and the redelivery finds it free instead of bouncing off it.
 * Renewal is token-checked: an attempt whose claim already lapsed cannot extend someone else's.
 *
 * Measured against a SIGKILLed worker (jobs.integration.test.ts): without renewal the stale claim
 * bounced four redeliveries and the mail arrived ~9 minutes late; with it the mail is sent within
 * about two and a half minutes of the kill, of which ~77 s is `platform-jobs` noticing the death.
 */
export const MAIL_CLAIM_LEASE_SECONDS = 60;
export const MAIL_CLAIM_RENEW_SECONDS = 30;

/**
 * How long a delivered message stays in the ledger. It has to outlast every retry of the job
 * (the retry window above plus the failed-job retention) with room to spare.
 */
export const MAIL_SENT_TTL_SECONDS = 7 * 24 * 60 * 60;

/** The longest one attempt waits for a send slot before giving the job back to the queue. */
export const MAIL_MAX_SLOT_WAIT_MS = 120_000;

/** Cooldown applied to a throttled mailbox when the provider did not say how long, and its bounds. */
export const MAIL_DEFAULT_COOLDOWN_SECONDS = 60;
export const MAIL_MAX_COOLDOWN_SECONDS = 600;

/**
 * Queue priority (higher runs first). Authentication mail — a verification link or a password
 * reset with a person waiting — goes ahead of anything queued before it; everything else,
 * digests and notifications included, stays at 0 so a bulk run cannot delay a login.
 */
export const MAIL_PRIORITY = Object.freeze({ auth: 10, default: 0 });

export function priorityFor(category: string): number {
  return category.startsWith('auth.') ? MAIL_PRIORITY.auth : MAIL_PRIORITY.default;
}

/**
 * The rule `platform-jobs`' `redrive` applies to `mail.send` dead letters: **authentication mail is
 * NEVER redriven.** Its link has expired by the time anyone looks, the user asks for a new one, and
 * redriving a stale reset or verification link only emails someone a dead link (and, for a reset,
 * leaves a bearer token in a mailbox for nothing). Enforced here, in the queue's one definition,
 * rather than left to an operator who remembers the README.
 *
 * Anything that is not recognisably a non-auth message is NOT redrived either: a payload without a
 * string `category` is not mail this package could have enqueued. The check is on the lower-cased
 * category, so a differently-cased `Auth.Reset` is still auth.
 */
export function mailCanRedrive(data: unknown): boolean {
  const category = (data as { category?: unknown } | null | undefined)?.category;
  if (typeof category !== 'string' || category.length === 0) return false;
  return !category.toLowerCase().startsWith('auth.');
}

/** Counters for what the queue did. All labels are bounded: a category and a closed error code. */
export interface MailTelemetry {
  sent(category: string): void;
  /** An attempt found the message already sent and did nothing. */
  duplicate(category: string): void;
  failed(category: string, code: string): void;
  /** An attempt had to wait for a send slot. */
  paced(waitedMs: number): void;
}

export interface MailLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

const NOOP_TELEMETRY: MailTelemetry = { sent() {}, duplicate() {}, failed() {}, paced() {} };
const NOOP_LOGGER: MailLogger = { info() {}, warn() {}, error() {} };

export interface MailQueue {
  /**
   * Queue a message. Resolves to the job id, or `null` when a message with the same
   * `idempotencyKey` is already queued. The message is validated HERE, before anything is
   * written, so a bad message fails the caller's transaction instead of a worker.
   *
   * Pass `tx` so the email exists only if the business write commits. Without it the job commits
   * on its own connection, independently of any transaction you have open.
   *
   * `priority` defaults by category: `auth.*` is {@link MAIL_PRIORITY}.auth, anything else 0.
   */
  enqueue(
    message: EmailMessage,
    options?: Omit<SendOptions, 'idempotencyKey'>,
  ): Promise<string | null>;
}

/**
 * Enqueue-only: what an API process needs. It needs no credentials and no ledger, because
 * nothing here talks to a provider. It DEFINES the queue with {@link MAIL_QUEUE_CONFIG}, so a
 * pod that never runs the handler still creates `mail.send` exactly as the worker does.
 * Resolves once the queue exists (awaited by `platform-jobs` when called after `start()`).
 */
export async function createMailQueue(
  jobs: Pick<Jobs, 'send' | 'defineQueue'>,
): Promise<MailQueue> {
  await jobs.defineQueue(MAIL_QUEUE, MAIL_QUEUE_CONFIG);
  return {
    // `async`, so an invalid message REJECTS like every other failure instead of throwing
    // synchronously out of a function that returns a promise.
    async enqueue(message, options = {}) {
      validateMessage(message);
      return jobs.send(MAIL_QUEUE, message, {
        ...options,
        priority: options.priority ?? priorityFor(message.category),
        idempotencyKey: message.idempotencyKey,
      });
    },
  };
}

export interface MailHandlerOptions {
  sender: EmailSender;
  state: MailState;
  /** The mailbox the pacing and the ledger are per. Defaults to `sender.mailbox`. */
  mailbox?: string | undefined;
  telemetry?: MailTelemetry | undefined;
  logger?: MailLogger | undefined;
  /** Test seam. */
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  /** Test seam: how often a live attempt renews its claim. Default {@link MAIL_CLAIM_RENEW_SECONDS}. */
  claimRenewMs?: number | undefined;
}

function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * A failure retrying cannot fix (400, 403, 404, 413, an invalid message, a misconfiguration)
 * dead-letters AT ONCE with no retries and no backoff to wait out. The text is the code and the
 * error's own message, which holds the HTTP status and the provider's request id and nothing else.
 */
/** A cooldown from the provider's `Retry-After`: at least a second, at most {@link MAIL_MAX_COOLDOWN_SECONDS}. */
function cooldownSeconds(retryAfterSeconds: number | undefined): number {
  return Math.min(
    MAIL_MAX_COOLDOWN_SECONDS,
    Math.max(1, retryAfterSeconds ?? MAIL_DEFAULT_COOLDOWN_SECONDS),
  );
}

function toJobError(error: unknown): unknown {
  if (error instanceof MailSendError && !error.retryable) {
    return new PermanentJobError(`mail.send failed permanently (${error.code}): ${error.message}`);
  }
  return error;
}

/**
 * The `mail.send` handler. For each job, in this order:
 *
 * 1. **Validate** the payload. A malformed one never succeeds: it dead-letters at once.
 * 2. **Claim the ledger entry for the message BEFORE sending.** If an earlier attempt already
 *    delivered it, finish without sending — a duplicate key produces one email. If another attempt
 *    holds the claim right now, fail retryably.
 * 3. **Wait for a send slot** on the sender mailbox: 20 a minute, burst 5, shared by every worker,
 *    and none at all while the mailbox is in a cooldown.
 * 4. **Send.** On success record it in the ledger (a failure to record is logged, not thrown:
 *    retrying would send it again).
 * 5. On failure **release the claim**; if the provider throttled, start the mailbox-wide
 *    cooldown; then rethrow — retryable errors go back to the queue with its backoff, permanent
 *    ones become a {@link PermanentJobError}.
 *
 * It cannot make delivery exactly-once: Graph has no idempotency key, so a message accepted by
 * Graph whose acknowledgement is lost can be sent twice by the retry. The ledger makes that window
 * as small as it can be made — and a lost message is the worse failure for a verification email.
 *
 * **Why a ledger and not `jobs.once`.** `once` runs its effect inside a database transaction and
 * holds that transaction and a row lock across the call. Here the effect is an HTTP request to
 * Graph, which PLAN §4.3 forbids ("never call an external provider inside an open database
 * transaction"); and it cannot be made atomic with the marker anyway. See ADR 0001, amendment of
 * the WP-8 author.
 */
export function createMailHandler(options: MailHandlerOptions): JobHandlerFn<EmailMessage> {
  const { sender, state } = options;
  const telemetry = options.telemetry ?? NOOP_TELEMETRY;
  const logger = options.logger ?? NOOP_LOGGER;
  const mailbox = options.mailbox ?? sender.mailbox ?? 'default';
  const sleep = options.sleep ?? sleepMs;
  const claimRenewMs = options.claimRenewMs ?? MAIL_CLAIM_RENEW_SECONDS * 1000;

  async function waitForSlot(signal: AbortSignal): Promise<void> {
    // Counted from the waits asked for, not the wall clock: it is what this attempt chose to
    // spend, and it does not drift with a slow database or a paused process.
    let waitedMs = 0;
    for (;;) {
      const waitMs = await state.takeSlot(mailbox);
      if (waitMs <= 0) break;
      if (waitedMs + waitMs > MAIL_MAX_SLOT_WAIT_MS) {
        throw new MailSendError(
          'throttled',
          'The sender mailbox is at its sending rate; try again later.',
          {
            retryAfterSeconds: Math.ceil(waitMs / 1000),
          },
        );
      }
      await sleep(waitMs, signal);
      waitedMs += waitMs;
    }
    if (waitedMs > 0) telemetry.paced(waitedMs);
  }

  async function run(job: JobContext<EmailMessage>): Promise<void> {
    let message;
    try {
      message = validateMessage(job.data);
    } catch (err) {
      const category = categoryOf(job.data);
      telemetry.failed(category, 'invalid_message');
      logger.error({ jobId: job.id, category }, 'mail.send job has an invalid payload');
      throw toJobError(err);
    }

    const key = ledgerKey(mailbox, message.idempotencyKey);
    const claim = await state.claim(key, MAIL_CLAIM_LEASE_SECONDS);

    if (claim.status === 'sent') {
      telemetry.duplicate(message.category);
      logger.info(
        { jobId: job.id, category: message.category, messageId: claim.id },
        'mail.send skipped: this message was already sent',
      );
      return;
    }
    if (claim.status === 'in-flight') {
      // Not a provider failure, but a retry spent: count it, so a dead worker's stale claim (or a
      // genuine race) is visible instead of looking like mail that simply took a while.
      telemetry.failed(message.category, 'in_flight');
      logger.warn(
        { jobId: job.id, category: message.category, code: 'in_flight', attempt: job.attempt },
        'mail.send attempt failed',
      );
      throw new MailSendError(
        'unavailable',
        'Another attempt is sending this message; retrying later.',
      );
    }

    // While this attempt works (waiting for a slot included) it keeps its claim alive; if it dies
    // the claim lapses on its own.
    const renewal = setInterval(() => {
      state.renew(key, claim.token, MAIL_CLAIM_LEASE_SECONDS).then(
        (held) => {
          if (!held) {
            logger.warn(
              { jobId: job.id, category: message.category },
              'mail.send lost its claim; another attempt may now send this message',
            );
          }
        },
        () => undefined, // a failed renewal is retried at the next tick; the lease is 2 ticks long
      );
    }, claimRenewMs);
    renewal.unref();

    let reachedProvider = false;
    try {
      await waitForSlot(job.signal);
      // A drain that ran out of its budget (or a job that lost its claim) aborts the signal. Never
      // START a send on an aborted attempt, whatever the transport would do with the signal: a
      // custom sender may ignore it. The claim is released below and the queue retries.
      if (job.signal.aborted) {
        throw new MailSendError('timeout', 'The attempt was aborted before the message was sent.');
      }
      reachedProvider = true;
      const result = await sender.send(message, {
        signal: job.signal,
        // The transport is about to wait out a 429 itself: tell every worker NOW, not after it
        // gives up, so the others do not keep sending into a mailbox Exchange just throttled.
        onThrottled: (seconds) => state.backOff(mailbox, cooldownSeconds(seconds)),
      });
      try {
        await state.markSent(key, result.id, MAIL_SENT_TTL_SECONDS);
      } catch (err) {
        // The email is out. Throwing would retry and send it again; say so and move on.
        logger.error(
          { jobId: job.id, category: message.category, err: String(err) },
          'mail.send delivered but could not record it in the ledger',
        );
      }
      telemetry.sent(message.category);
      logger.info(
        { jobId: job.id, category: message.category, messageId: result.id, attempt: job.attempt },
        'mail.send delivered',
      );
    } catch (err) {
      const code = err instanceof MailSendError ? err.code : 'network';
      telemetry.failed(message.category, code);
      // Code only: never the message, a recipient or the provider's free text.
      logger.warn(
        { jobId: job.id, category: message.category, code, attempt: job.attempt },
        'mail.send attempt failed',
      );

      try {
        await state.release(key, claim.token);
      } catch {
        // The lease expires on its own; the retry waits for it.
      }
      if (reachedProvider && err instanceof MailSendError && err.code === 'throttled') {
        // Exchange told us to stop: every worker must, not just the one that was told.
        try {
          await state.backOff(mailbox, cooldownSeconds(err.retryAfterSeconds));
        } catch {
          // Best effort: the job's own retry backoff still applies.
        }
      }
      throw toJobError(err);
    } finally {
      clearInterval(renewal);
    }
  }

  return (job) => {
    // Continue the request's correlation id (contract §7) when the payload carries one; else
    // platform-jobs has already seeded `mail.send:<jobId>`. The id comes from a job payload, so it
    // is validated BEFORE it becomes the log context: an invalid one (a newline, 5000 characters)
    // is never entered, never logged, and `run` then rejects the payload as invalid.
    const correlationId = job.data?.correlationId;
    return isCorrelationId(correlationId)
      ? Promise.resolve(withJobContext(MAIL_QUEUE, () => run(job), { correlationId }))
      : run(job);
  };
}

/**
 * Register the `mail.send` handler and return the enqueue side.
 *
 * Call it from every process. `platform-jobs` records the queue everywhere but RUNS the handler
 * only when `ROLE=worker`, and the order against `jobs.start()` does not matter: registered before
 * `start()` it is started by it, registered after it is started at once. (In NestJS use
 * `MailModule`, which registers through `@JobHandler` so `JobsModule` does it for you.)
 */
export async function registerMailJobs(
  jobs: Pick<Jobs, 'send' | 'defineQueue' | 'handle'>,
  options: MailHandlerOptions,
): Promise<MailQueue> {
  await jobs.handle(MAIL_QUEUE, createMailHandler(options), MAIL_HANDLE_OPTIONS);
  return createMailQueue(jobs);
}

function categoryOf(data: unknown): string {
  const category = (data as { category?: unknown } | null)?.category;
  return typeof category === 'string' && category.length <= 64 ? category : 'unknown';
}

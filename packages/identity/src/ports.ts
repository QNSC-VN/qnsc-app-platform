import type { DbExecutor } from '@quynhonsemiconductor/platform-db/drizzle';

/**
 * The ports identity v8 depends on. Each is satisfied by a shared package (`platform-mail`,
 * `platform-jobs`) or by a few lines in the product; identity never imports either, so it builds
 * and tests without them (APP-PLATFORM-PLAN.md §6.8, §6.10).
 */

/** A finished email. Rendering is the product's job; identity only decides when to send one. */
export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Machine-readable purpose, for routing and metrics. */
  category: 'auth.verify-email' | 'auth.reset-password';
  /** Stable per message: a duplicate key must produce one email. */
  idempotencyKey: string;
  /**
   * The correlation id of the request that caused this email (platform contract §7), so the worker's
   * log lines carry it. Optional, and mirrors `platform-mail`'s field: the two `EmailMessage` types stay
   * assignable both ways. NOT part of the idempotency key. Omitted, never invalid, when there is none.
   */
  correlationId?: string | undefined;
}

/** The `EmailSender` contract of `platform-mail` (§6.8). Identity names it; it never calls it directly. */
export interface EmailSender {
  send(message: EmailMessage): Promise<{ id: string }>;
}

export interface JobSendOptions {
  /** Enlist in this transaction: roll back and there is no job. Omitted: its own statement. */
  tx?: DbExecutor | undefined;
  /** A second `send` with the same key creates no second job (it resolves to `null`). */
  idempotencyKey?: string | undefined;
  startAfter?: Date | number | undefined;
  /** Higher runs first. */
  priority?: number | undefined;
}

/**
 * `jobs.send(queue, data, { tx, idempotencyKey, priority, … })` of `platform-jobs` (§6.7). The real
 * `Jobs` type is assignable to this (`ports.types.test.ts`).
 *
 * There is deliberately NO per-send retention here: `platform-jobs` has none. How long a finished job
 * stays is a property of the QUEUE, set where the queue is registered (see {@link MAIL_QUEUE}).
 */
export interface JobEnqueue {
  send(queue: string, data: object, options?: JobSendOptions): Promise<string | null>;
}

/**
 * The slice of `platform-jobs` the purge needs: a schedule and a handler. `Jobs` is assignable to it;
 * its handler receives the job context (`{ id, data, attempt, signal }`), of which the purge needs none.
 */
export interface JobRegistry {
  schedule(
    name: string,
    cron: string,
    data?: object,
    options?: { tz?: string },
  ): Promise<void> | void;
  handle(queue: string, handler: (job: { data: unknown }) => Promise<void>): Promise<void> | void;
}

/**
 * The `mail.send` queue of `platform-mail`.
 *
 * Reset and verification links are bearer tokens in clear in the job row, so how long a finished job is
 * kept matters (ADR 0002, decision 4). That is the QUEUE's configuration, owned by `platform-mail`
 * (`MAIL_QUEUE_CONFIG`: a completed job is deleted at once, a failed or dead-lettered one is kept 24 h),
 * and it applies only if `mail.send` was registered through `platform-mail` in EVERY process that
 * enqueues. An unregistered queue makes `send` fail: it fails closed and never falls back to the
 * library's defaults, which would keep the links for days.
 */
export const MAIL_QUEUE = 'mail.send';

/**
 * Auth mail jumps the queue: a bulk digest sharing `mail.send` must not delay a verification or reset
 * mail that someone is waiting for. Higher runs first; the default is 0.
 */
export const AUTH_MAIL_PRIORITY = 10;

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** The product's templates: content and language are never identity's. */
export interface AuthEmailTemplates {
  verifyEmail(input: {
    user: { id: string; email: string; name: string };
    url: string;
  }): RenderedEmail;
  resetPassword(input: {
    user: { id: string; email: string; name: string };
    url: string;
  }): RenderedEmail;
}

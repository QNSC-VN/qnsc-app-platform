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
}

/** The `EmailSender` contract of `platform-mail` (§6.8). Identity names it; it never calls it directly. */
export interface EmailSender {
  send(message: EmailMessage): Promise<{ id: string }>;
}

/**
 * What a queue does with a job after it ran. Auth emails carry bearer links (verification, reset)
 * in clear in the job payload, so the queue must not keep them: ADR 0002, decision 4.
 */
export interface JobRetention {
  /** Delete the job row as soon as it completes. */
  deleteWhenCompleted: boolean;
  /** Keep a failed or dead-lettered job at most this long. */
  keepFailedSeconds: number;
}

export interface JobSendOptions {
  /** Enlist in this transaction: roll back and there is no job. Omitted: its own statement. */
  tx?: DbExecutor | undefined;
  /** A second `send` with the same key creates no second job (it resolves to `null`). */
  idempotencyKey?: string | undefined;
  startAfter?: Date | number | undefined;
  priority?: number | undefined;
  retention?: JobRetention | undefined;
}

/** `jobs.send(queue, data, { tx, idempotencyKey, … })` of `platform-jobs` (§6.7). */
export interface JobEnqueue {
  send(queue: string, data: object, options?: JobSendOptions): Promise<string | null>;
}

/** The slice of `platform-jobs` the purge needs: a schedule and a handler. */
export interface JobRegistry {
  schedule(
    name: string,
    cron: string,
    data: object,
    options?: { tz?: string },
  ): Promise<void> | void;
  handle(queue: string, handler: (data: unknown) => Promise<void>): Promise<void> | void;
}

/** The `mail.send` queue of `platform-mail`. */
export const MAIL_QUEUE = 'mail.send';

/** What identity asks of the `mail.send` queue for every auth email. */
export const AUTH_MAIL_RETENTION: JobRetention = Object.freeze({
  deleteWhenCompleted: true,
  keepFailedSeconds: 24 * 60 * 60,
});

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

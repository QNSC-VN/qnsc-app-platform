import { createHash } from 'node:crypto';
import {
  AUTH_MAIL_PRIORITY,
  MAIL_QUEUE,
  type AuthEmailTemplates,
  type EmailMessage,
  type JobEnqueue,
} from './ports';
import { requestCorrelationId, validCorrelationId } from './correlation';
import { consoleLogger, MAIL_ENQUEUE_FAILED, type IdentityLogger } from './events';
import { currentAuthTransaction } from './tx-context';

/** What Better Auth hands an email callback. */
export interface AuthMailInput {
  user: { id: string; email: string; name: string };
  url: string;
  token: string;
}

export type MailPurpose = 'verify-email' | 'reset-password';

/**
 * Idempotency key per message: `<purpose>:<userId>:<sha256(token)>`. The token is hashed so the key —
 * stored in a job row and in logs — never contains a usable credential.
 */
export function mailIdempotencyKey(purpose: MailPurpose, userId: string, token: string): string {
  return `${purpose}:${userId}:${createHash('sha256').update(token).digest('hex')}`;
}

/**
 * Better Auth email callbacks -> `mail.send` jobs. The callback returns when the job is enqueued,
 * never when the mail is sent (APP-PLATFORM-PLAN.md §4.3 case 1), so a slow provider is not on the
 * sign-up path and response time does not reveal whether an address has an account.
 *
 * Sign-up's verification mail is the one callback Better Auth runs inside its database
 * transaction; there the job joins that transaction (`tx`) and rolls back with the user. Every other
 * callback runs outside any transaction and enqueues on its own, which is safe: the token exists
 * before the job does (WP-9, criterion 9).
 */
export class AuthMail {
  constructor(
    private readonly jobs: JobEnqueue,
    private readonly templates: AuthEmailTemplates,
    /** Per-email cap (D14). Resolves false to drop the mail silently. */
    private readonly allow: (purpose: MailPurpose, email: string) => Promise<boolean> = async () =>
      true,
    private readonly logger: IdentityLogger = consoleLogger,
    /** The id to carry into the job. Default: the request context's (see `correlation.ts`). */
    private readonly correlationId: () => string | undefined = requestCorrelationId,
  ) {}

  sendVerification(input: AuthMailInput): Promise<void> {
    return this.enqueue(
      'verify-email',
      'auth.verify-email',
      input,
      this.templates.verifyEmail(input),
    );
  }

  sendPasswordReset(input: AuthMailInput): Promise<void> {
    return this.enqueue(
      'reset-password',
      'auth.reset-password',
      input,
      this.templates.resetPassword(input),
    );
  }

  private async enqueue(
    purpose: MailPurpose,
    category: EmailMessage['category'],
    { user, token }: AuthMailInput,
    rendered: { subject: string; html: string; text: string },
  ): Promise<void> {
    if (!(await this.allow(purpose, user.email))) return;
    const idempotencyKey = mailIdempotencyKey(purpose, user.id, token);
    // Checked again here whatever the source: only a contract-§7 id is ever put in a payload.
    const correlationId = validCorrelationId(this.correlationId());
    const message: EmailMessage = {
      to: user.email,
      ...rendered,
      category,
      idempotencyKey,
      ...(correlationId ? { correlationId } : {}),
    };
    try {
      await this.jobs.send(MAIL_QUEUE, message, {
        tx: currentAuthTransaction(),
        idempotencyKey,
        priority: AUTH_MAIL_PRIORITY,
      });
    } catch (error) {
      // Better Auth swallows what a callback throws and answers 200, so a product whose `mail.send` is
      // not registered would look healthy while sending nothing. Say so, then rethrow so the enclosing
      // transaction still sees the failure. Fields are the queue, the purpose and the error's class:
      // never the address, the token, the link, or the error's message (a database error can quote them).
      this.logger.error(`${MAIL_ENQUEUE_FAILED}: could not enqueue ${purpose} on ${MAIL_QUEUE}`, {
        code: MAIL_ENQUEUE_FAILED,
        queue: MAIL_QUEUE,
        purpose,
        error: error instanceof Error ? error.name : 'unknown',
      });
      throw error;
    }
  }
}

import type { User } from 'better-auth';
import { mailIdempotencyKey, MAIL_QUEUE, type EmailMessage } from '../jobs/mail';
import type { JobsApi } from '../jobs/jobs-api';
import { currentAuthTransaction } from './tx-context';
import type { AuthEmailPort } from './ports';

/** What one callback invocation saw. The spike's measurement for criterion 9. */
export interface CallbackObservation {
  purpose: 'verify-email' | 'reset-password';
  userId: string;
  /** Was a Better Auth transaction open (and therefore joinable) when the callback ran? */
  inTransaction: boolean;
}

export type EnqueueMode =
  /** Join Better Auth's transaction when there is one (the design this spike recommends). */
  | 'transactional'
  /** Always enqueue on the pool, never in the transaction (the plan's fallback). */
  | 'outside';

/**
 * `AuthEmailPort` over `jobs.send('mail.send', …)`. It RENDERS nothing a product would not
 * render itself: subject and body here are placeholders; templates are the product's.
 *
 * The callback returns when the job is enqueued, never when the mail is sent (plan §4.3 case 1):
 * Better Auth awaits it, so a slow provider must not be on this path.
 */
export class JobEmailPort implements AuthEmailPort {
  readonly observations: CallbackObservation[] = [];

  constructor(
    private readonly jobs: JobsApi,
    private readonly mode: EnqueueMode = 'transactional',
  ) {}

  sendVerification(input: { user: User; url: string; token: string }): Promise<void> {
    return this.enqueue('verify-email', 'auth.verify-email', input);
  }

  sendPasswordReset(input: { user: User; url: string; token: string }): Promise<void> {
    return this.enqueue('reset-password', 'auth.reset-password', input);
  }

  private async enqueue(
    purpose: CallbackObservation['purpose'],
    category: EmailMessage['category'],
    { user, url, token }: { user: User; url: string; token: string },
  ): Promise<void> {
    const tx = this.mode === 'transactional' ? currentAuthTransaction() : undefined;
    this.observations.push({
      purpose,
      userId: user.id,
      inTransaction: currentAuthTransaction() !== undefined,
    });
    const idempotencyKey = mailIdempotencyKey(purpose, user.id, token);
    const message: EmailMessage = {
      to: user.email,
      subject: purpose === 'verify-email' ? 'Verify your email' : 'Reset your password',
      html: `<a href="${url}">${url}</a>`,
      text: url,
      category,
      idempotencyKey,
    };
    await this.jobs.send(MAIL_QUEUE, message, { tx, idempotencyKey });
  }
}

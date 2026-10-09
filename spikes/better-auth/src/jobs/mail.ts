import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { DbExecutor } from '@quynhonsemiconductor/platform-db/drizzle';
import type { JobsApi } from './jobs-api';

/** `EmailMessage` of APP-PLATFORM-PLAN.md §6.8, minus the fields this spike does not use. */
export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  category: 'auth.verify-email' | 'auth.reset-password';
  idempotencyKey: string;
}

/** The `EmailSender` contract of §6.8 (what `platform-mail` will satisfy). */
export interface EmailSender {
  send(message: EmailMessage): Promise<{ id: string }>;
}

export const MAIL_QUEUE = 'mail.send';

/**
 * Idempotency key per message: `<purpose>:<userId>:<sha256(token)>` — the key
 * APP-PLATFORM-IDENTITY-V8-PLAN.md §8.1 criterion 9 prescribes. The token is hashed so the key
 * (stored in a job row and in logs) never contains a usable credential.
 */
export function mailIdempotencyKey(purpose: string, userId: string, token: string): string {
  return `${purpose}:${userId}:${createHash('sha256').update(token).digest('hex')}`;
}

/**
 * The `mail.send` handler (WP-8's `registerMailJobs`): claims due jobs, checks the idempotency key
 * against a ledger BEFORE the side effect, sends, then records. A job delivered twice (at-least-once)
 * sends once.
 */
export class MailSendWorker {
  constructor(
    private readonly db: DbExecutor,
    private readonly sender: EmailSender,
  ) {}

  static readonly LEDGER_DDL = `
    CREATE TABLE IF NOT EXISTS spike_mail_ledger (
      idempotency_key text PRIMARY KEY,
      sent_at         timestamptz NOT NULL DEFAULT now()
    );`;

  /** Run every due job once; returns how many `send()` calls reached the sender. */
  async drain(): Promise<number> {
    const claimed = await this.db.execute(sql`
      UPDATE spike_jobs SET state = 'active'
      WHERE id IN (SELECT id FROM spike_jobs
                   WHERE queue = ${MAIL_QUEUE} AND state = 'created' AND start_after <= now()
                   ORDER BY priority DESC, created_at FOR UPDATE SKIP LOCKED)
      RETURNING id, data`);
    let sent = 0;
    for (const row of claimed.rows as Array<{ id: string; data: EmailMessage }>) {
      const already = await this.db.execute(
        sql`SELECT 1 FROM spike_mail_ledger WHERE idempotency_key = ${row.data.idempotencyKey}`,
      );
      if (already.rows.length === 0) {
        await this.sender.send(row.data);
        await this.db.execute(
          sql`INSERT INTO spike_mail_ledger (idempotency_key) VALUES (${row.data.idempotencyKey})
              ON CONFLICT DO NOTHING`,
        );
        sent += 1;
      }
      await this.db.execute(sql`UPDATE spike_jobs SET state = 'completed' WHERE id = ${row.id}`);
    }
    return sent;
  }
}

/** In-memory `EmailSender` (the `platform-mail/testing` sender of §6.8). */
export class MemorySender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<{ id: string }> {
    this.sent.push(message);
    return { id: String(this.sent.length) };
  }
}

export type { JobsApi };

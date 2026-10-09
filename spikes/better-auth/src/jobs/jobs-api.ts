import { sql } from 'drizzle-orm';
import type { DbExecutor } from '@quynhonsemiconductor/platform-db/drizzle';

/**
 * STAND-IN for `@quynhonsemiconductor/platform-jobs` (WP-7), which does not exist yet and whose
 * pg-boss spike (WP-6) has not reported. It has the public shape APP-PLATFORM-PLAN.md §6.7
 * specifies, so the code under test is what WP-10 will write:
 *
 *   jobs.send(queue, data, { tx, idempotencyKey, startAfter, priority })
 *
 * and the semantics §6.7 relies on, built the way pg-boss does it: the job is a ROW in the
 * product's own database, written through the caller's `DbExecutor`, so a rolled-back
 * transaction leaves no job, and the idempotency key is a unique `(queue, key)` that makes a
 * second `send` a no-op (pg-boss `singletonKey`).
 *
 * The consumer side (`MailSendWorker`) is deliberately in a different file: it is what the
 * `mail.send` handler of `platform-mail` (WP-8) will be.
 */
export interface SendOptions {
  /** Enlist in this transaction. Omitted: its own statement on the primary pool. */
  tx?: DbExecutor | undefined;
  idempotencyKey?: string | undefined;
  startAfter?: Date | number | undefined;
  priority?: number | undefined;
}

export interface JobsApi {
  /** Resolves to the job id, or `null` when `idempotencyKey` matched an existing job. */
  send(queue: string, data: unknown, options?: SendOptions): Promise<string | null>;
}

export const SPIKE_JOBS_DDL = `
CREATE TABLE IF NOT EXISTS spike_jobs (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  queue           text NOT NULL,
  data            jsonb NOT NULL,
  idempotency_key text,
  priority        integer NOT NULL DEFAULT 0,
  start_after     timestamptz NOT NULL DEFAULT now(),
  state           text NOT NULL DEFAULT 'created',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS spike_jobs_idem ON spike_jobs (queue, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
`;

export class StubJobs implements JobsApi {
  constructor(private readonly db: DbExecutor) {}

  async send(queue: string, data: unknown, options: SendOptions = {}): Promise<string | null> {
    const executor = options.tx ?? this.db;
    const startAfter =
      options.startAfter instanceof Date
        ? options.startAfter
        : new Date(Date.now() + (options.startAfter ?? 0) * 1000);
    const result = await executor.execute(sql`
      INSERT INTO spike_jobs (queue, data, idempotency_key, priority, start_after)
      VALUES (${queue}, ${JSON.stringify(data)}::jsonb, ${options.idempotencyKey ?? null},
              ${options.priority ?? 0}, ${startAfter})
      ON CONFLICT (queue, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
      RETURNING id`);
    const row = result.rows[0] as { id: string } | undefined;
    return row?.id ?? null;
  }
}

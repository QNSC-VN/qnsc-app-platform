import { sql } from 'drizzle-orm';
import type { DbExecutor } from '@quynhonsemiconductor/platform-db/drizzle';
import type { JobEnqueue, JobSendOptions } from '../ports';

/**
 * A `JobEnqueue` for tests, with the semantics `platform-jobs` promises (APP-PLATFORM-PLAN.md §6.7):
 * the job is a ROW written through the caller's `DbExecutor`, so a rolled-back transaction leaves no
 * job, and a duplicate idempotency key creates none (resolves `null`). It also records the retention
 * identity asked for, so a test can assert what the `mail.send` queue was told to keep.
 */
export const TEST_JOBS_DDL = `
CREATE TABLE IF NOT EXISTS identity_test_jobs (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  queue text NOT NULL,
  data jsonb NOT NULL,
  idempotency_key text,
  retention jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS identity_test_jobs_idem ON identity_test_jobs (queue, idempotency_key)
  WHERE idempotency_key IS NOT NULL;`;

export class TestJobs implements JobEnqueue {
  constructor(private readonly db: DbExecutor) {}

  async send(queue: string, data: object, options: JobSendOptions = {}): Promise<string | null> {
    const result = await (options.tx ?? this.db).execute(sql`
      INSERT INTO identity_test_jobs (queue, data, idempotency_key, retention)
      VALUES (${queue}, ${JSON.stringify(data)}::jsonb, ${options.idempotencyKey ?? null},
              ${options.retention ? JSON.stringify(options.retention) : null}::jsonb)
      ON CONFLICT (queue, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
      RETURNING id`);
    return (result.rows[0] as { id: string } | undefined)?.id ?? null;
  }
}

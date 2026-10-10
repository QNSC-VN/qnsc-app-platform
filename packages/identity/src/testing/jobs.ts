import { sql } from 'drizzle-orm';
import type { DbExecutor } from '@quynhonsemiconductor/platform-db/drizzle';
import type { JobEnqueue, JobSendOptions } from '../ports';

/**
 * A `JobEnqueue` for tests, with the semantics `platform-jobs` promises (APP-PLATFORM-PLAN.md §6.7):
 * the job is a ROW written through the caller's `DbExecutor`, so a rolled-back transaction leaves no
 * job, and a duplicate idempotency key creates none (resolves `null`). It records the options each
 * `send` received (without the transaction) so a test can assert exactly what identity asked for, and,
 * like `platform-jobs`, it REFUSES a queue nobody registered instead of creating it with defaults.
 */
export const TEST_JOBS_DDL = `
CREATE TABLE IF NOT EXISTS identity_test_jobs (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  queue text NOT NULL,
  data jsonb NOT NULL,
  idempotency_key text,
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS identity_test_jobs_idem ON identity_test_jobs (queue, idempotency_key)
  WHERE idempotency_key IS NOT NULL;`;

export class TestJobs implements JobEnqueue {
  /**
   * @param registeredQueues when given, `send` to any other queue throws, as `platform-jobs` does for a
   * queue that was never defined in this process. Omitted: every queue is accepted.
   */
  constructor(
    private readonly db: DbExecutor,
    private readonly registeredQueues?: ReadonlySet<string>,
  ) {}

  async send(queue: string, data: object, options: JobSendOptions = {}): Promise<string | null> {
    if (this.registeredQueues && !this.registeredQueues.has(queue)) {
      throw new Error(`queue "${queue}" is not registered in this process`);
    }
    const { tx, ...recorded } = options;
    const result = await (tx ?? this.db).execute(sql`
      INSERT INTO identity_test_jobs (queue, data, idempotency_key, options)
      VALUES (${queue}, ${JSON.stringify(data)}::jsonb, ${options.idempotencyKey ?? null},
              ${JSON.stringify(recorded)}::jsonb)
      ON CONFLICT (queue, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
      RETURNING id`);
    return (result.rows[0] as { id: string } | undefined)?.id ?? null;
  }
}

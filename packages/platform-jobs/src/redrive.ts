import type { Pool, PoolClient } from 'pg';
import { JobsConfigError } from './config';
import type { RedriveOptions, RedriveResult } from './types';

/** The part of `boss.send` a redrive needs, so this file imports no pg-boss type. */
export type SendInto = (
  queue: string,
  data: object,
  options: {
    id: string;
    priority: number;
    db: { executeSql(text: string, values?: unknown[]): Promise<unknown> };
  },
) => Promise<string | null>;

export interface RedriveDeps {
  pool: Pool;
  send: SendInto;
  warn(message: string): void;
  /**
   * The `canRedrive` policy of the origin queue AS DEFINED IN THIS PROCESS: `undefined` when the
   * queue is not defined here (so no rule can be applied), `null` when it is defined without one,
   * otherwise the rule.
   */
  policyFor(origin: string): ((data: unknown) => boolean) | null | undefined;
}

export const REDRIVE_DEFAULT_LIMIT = 100;
export const REDRIVE_MAX_LIMIT = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface DeadLetter {
  id: string;
  data: object;
  priority: number;
  source_name: string | null;
  source_id: string | null;
}

/**
 * - `moved`: back on the origin queue.
 * - `taken`: another redrive (or a worker) got to the copy first.
 * - `left`: cannot move for a reason that is logged (no origin, the origin queue is gone, a job with
 *   its id exists).
 * - `rejected`: left by POLICY (`canRedrive`), or because the policy could not be applied.
 */
type Outcome = 'moved' | 'taken' | 'left' | 'rejected';

/**
 * Move dead-letter copies of `dlq` back to the queue they came from, as new jobs with a FRESH retry
 * budget and the SAME job id, and report how many moved and how many the origin queue's policy
 * skipped.
 *
 * - **Same id.** The copy records the id of the job that died (`source_id`). The redriven job gets it,
 *   so `idempotencyKey` (a UUIDv5 of queue and key, used as the job id) still deduplicates: a `send`
 *   with that key afterwards returns `null` while the job is queued or retained, and the redriven job
 *   never runs beside a duplicate. pg-boss's own `redrive()` gives every job a NEW random id, which is
 *   why this is not a wrapper around it. The dead original, if retention has not removed it yet, is
 *   removed in the same transaction (it holds the id).
 * - **Fresh budget, current configuration.** The job is inserted by `send`, so it takes the origin
 *   queue's configuration AS IT IS NOW: retry limit and backoff, expiry, heartbeat, and retention. It
 *   starts at attempt 1.
 * - **Atomic per job, safe to run twice at once.** Each job moves in its own transaction: lock the copy
 *   (`FOR UPDATE SKIP LOCKED`), free the id, insert the job, delete the copy, commit. A crash leaves the
 *   copy where it was; two concurrent redrives never move the same copy, and one that finds it taken
 *   skips it.
 * - **Never loses a payload.** A copy that cannot be moved stays in the dead-letter queue, untouched,
 *   and is reported in the log: no recorded origin, the origin queue is gone, or a job with that id
 *   exists in the origin queue (live, or retained after it finished).
 * - **Policy.** The origin queue's `canRedrive` rule is applied first. A copy it rejects (or that makes
 *   it throw) is left in place and counted in `skipped`; so is a copy whose origin queue is not defined
 *   in this process, because its rule cannot be applied. Only a COUNT is ever logged, never a payload.
 * - Oldest first. A copy a worker is handling (`active`) is not a candidate.
 */
export async function redriveDeadLetters(
  deps: RedriveDeps,
  dlq: string,
  options: RedriveOptions = {},
): Promise<RedriveResult> {
  const limit = options.limit ?? REDRIVE_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > REDRIVE_MAX_LIMIT) {
    throw new JobsConfigError(
      `redrive: limit must be an integer between 1 and ${REDRIVE_MAX_LIMIT}, received ${limit}.`,
    );
  }
  const filter = options.filter ?? {};
  for (const id of filter.ids ?? []) {
    if (!UUID.test(id)) {
      throw new JobsConfigError(`redrive: filter.ids holds "${id}", which is not a job id.`);
    }
  }

  const { rows: owners } = await deps.pool.query<{ name: string }>(
    'SELECT name FROM pgboss.queue WHERE dead_letter = $1 LIMIT 1',
    [dlq],
  );
  if (owners.length === 0) {
    throw new JobsConfigError(
      `redrive: "${dlq}" is not a dead-letter queue (no queue names it as its dead letter). ` +
        'Pass the dead-letter queue, for example "mail.send.dlq".',
    );
  }

  const tried = new Set<string>();
  const rejected = new Map<string, number>();
  let moved = 0;
  let skipped = 0;
  while (moved < limit) {
    const candidates = await candidateIds(deps.pool, dlq, filter, limit - moved, [...tried]);
    if (candidates.length === 0) break;
    for (const id of candidates) {
      tried.add(id);
      const outcome = await moveOne(deps, dlq, id, rejected);
      if (outcome === 'moved') moved++;
      if (outcome === 'rejected') skipped++;
      if (moved >= limit) break;
    }
  }
  // A count per origin queue; never a payload.
  for (const [origin, count] of rejected) {
    deps.warn(
      `redrive: ${dlq}: ${count} dead letter${count === 1 ? '' : 's'} from "${origin}" left in place by its canRedrive policy (or because that queue is not defined in this process)`,
    );
  }
  return { moved, skipped };
}

async function candidateIds(
  pool: Pool,
  dlq: string,
  filter: NonNullable<RedriveOptions['filter']>,
  n: number,
  exclude: string[],
): Promise<string[]> {
  const params: unknown[] = [dlq, n, exclude];
  const where = [
    'name = $1',
    // `created` and `retry` are waiting; a copy a worker is handling (`active`) is its business.
    "state < 'active'",
    // A copy past its own deadline is as good as deleted: dead-letter queues are not swept, and
    // pg-boss deletes it on its next pass (every 15 minutes). Redriving it in the meantime would give
    // a payload that was meant to be gone a brand new window.
    'keep_until > now()',
    'id <> ALL($3::uuid[])',
  ];
  if (filter.ids) {
    params.push(filter.ids);
    where.push(`id = ANY($${params.length}::uuid[])`);
  }
  if (filter.createdBefore) {
    params.push(filter.createdBefore);
    where.push(`created_on < $${params.length}`);
  }
  if (filter.origin) {
    params.push(filter.origin);
    where.push(`source_name = $${params.length}`);
  }
  if (filter.data) {
    params.push(JSON.stringify(filter.data));
    where.push(`data @> $${params.length}::jsonb`);
  }
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM pgboss.job WHERE ${where.join(' AND ')} ORDER BY created_on, id LIMIT $2`,
    params,
  );
  return rows.map((r) => r.id);
}

async function moveOne(
  deps: RedriveDeps,
  dlq: string,
  id: string,
  rejected: Map<string, number>,
): Promise<Outcome> {
  const client = await deps.pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN');
    try {
      const outcome = await move(deps, client, dlq, id, rejected);
      await client.query(outcome === 'moved' ? 'COMMIT' : 'ROLLBACK');
      return outcome;
    } catch (error) {
      await client.query('ROLLBACK').catch((e: unknown) => {
        broken = e instanceof Error ? e : new Error(String(e));
      });
      throw error;
    }
  } finally {
    // A connection that could not even roll back is not returned to the pool.
    client.release(broken);
  }
}

async function move(
  deps: RedriveDeps,
  client: PoolClient,
  dlq: string,
  id: string,
  rejected: Map<string, number>,
): Promise<Outcome> {
  // Re-read under a lock: another redrive may have taken it, or a worker started handling it, since
  // the candidate list was read.
  const { rows } = await client.query<DeadLetter>(
    `SELECT id, data, priority, source_name, source_id FROM pgboss.job
      WHERE name = $1 AND id = $2 AND state < 'active' AND keep_until > now()
      FOR UPDATE SKIP LOCKED`,
    [dlq, id],
  );
  const copy = rows[0];
  if (!copy) return 'taken';

  if (!copy.source_name || !copy.source_id) {
    deps.warn(`redrive: ${dlq}/${id} records no origin queue or job id; leaving it in place`);
    return 'left';
  }
  const { rows: origin } = await client.query('SELECT 1 FROM pgboss.queue WHERE name = $1', [
    copy.source_name,
  ]);
  if (origin.length === 0) {
    deps.warn(
      `redrive: ${dlq}/${id}: its origin queue "${copy.source_name}" no longer exists; leaving it in place`,
    );
    return 'left';
  }

  // The origin queue's rule decides first, from the definition in THIS process. A queue that is not
  // defined here has no rule to apply, and a payload that must never be redriven (authentication
  // mail) cannot be told apart without it, so it stays.
  const policy = deps.policyFor(copy.source_name);
  if (policy === undefined || !allowed(deps, policy, copy)) {
    rejected.set(copy.source_name, (rejected.get(copy.source_name) ?? 0) + 1);
    return 'rejected';
  }

  // The dead original holds the id until retention removes it. It is ALWAYS a `failed` row; a row in
  // any other state with this id (live, or completed or cancelled and still retained) belongs to a
  // LATER job that was sent with the same idempotency key, and replacing it would run old work again
  // beside, or instead of, the new. It is left alone, `send` below conflicts on the id, and the copy
  // stays.
  await client.query(`DELETE FROM pgboss.job WHERE name = $1 AND id = $2 AND state = 'failed'`, [
    copy.source_name,
    copy.source_id,
  ]);

  // Through `send`, on THIS transaction: the origin queue's configuration applies as it is now, the
  // retry budget is fresh, and the insert is part of the same commit as the delete below.
  const inserted = await deps.send(copy.source_name, copy.data, {
    id: copy.source_id,
    priority: copy.priority,
    db: { executeSql: (text, values) => client.query(text, values as unknown[] | undefined) },
  });
  if (inserted === null) {
    deps.warn(
      `redrive: ${dlq}/${id}: a job with id ${copy.source_id} already exists in "${copy.source_name}" (live, or retained after it finished); leaving it in place`,
    );
    return 'left';
  }

  await client.query('DELETE FROM pgboss.job WHERE name = $1 AND id = $2', [dlq, id]);
  return 'moved';
}

/** `null` is a queue defined without a rule: everything may be redriven. A rule that throws forbids. */
function allowed(
  deps: RedriveDeps,
  policy: ((data: unknown) => boolean) | null,
  copy: DeadLetter,
): boolean {
  if (policy === null) return true;
  try {
    return policy(copy.data) === true;
  } catch (error) {
    // The message of the rule's own error, never the payload it was looking at.
    deps.warn(
      `redrive: canRedrive for "${copy.source_name}" threw (${error instanceof Error ? error.message : 'unknown error'}); treating the dead letter as not redrivable`,
    );
    return false;
  }
}

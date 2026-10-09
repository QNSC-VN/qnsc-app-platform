import type { Pool } from 'pg';

export interface JobRow {
  id: string;
  name: string;
  state: 'created' | 'retry' | 'active' | 'completed' | 'cancelled' | 'failed';
  retry_count: number;
  retry_limit: number;
  singleton_key: string | null;
  data: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  created_on: Date;
  start_after: Date;
  started_on: Date | null;
  completed_on: Date | null;
}

/** Jobs are rows: this is also the query shape the Grafana panels use. */
export async function jobRows(pool: Pool, queue: string): Promise<JobRow[]> {
  const { rows } = await pool.query<JobRow>(
    `SELECT id, name, state, retry_count, retry_limit, singleton_key, data, output,
            created_on, start_after, started_on, completed_on
       FROM pgboss.job WHERE name = $1 ORDER BY created_on, id`,
    [queue],
  );
  return rows;
}

export async function jobCount(pool: Pool, queue: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    'SELECT count(*) AS n FROM pgboss.job WHERE name = $1',
    [queue],
  );
  return Number(rows[0]!.n);
}

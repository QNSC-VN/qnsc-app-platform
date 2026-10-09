import type { Pool } from 'pg';

export interface Transition {
  /** Epoch ms when the poller first SAW this state (resolution = the poll interval). */
  at: number;
  state: string;
  retryCount: number;
}

/**
 * Watch one job row and record every distinct (state, retry_count) it passes through, so a
 * scenario can assert the SEQUENCE (active → retry → active → completed), not just the end.
 */
export function trackJob(pool: Pool, id: string, intervalMs = 250) {
  const transitions: Transition[] = [];
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      try {
        const { rows } = await pool.query<{ state: string; retry_count: number }>(
          'SELECT state, retry_count FROM pgboss.job WHERE id = $1',
          [id],
        );
        const row = rows[0];
        const last = transitions.at(-1);
        if (row && (!last || last.state !== row.state || last.retryCount !== row.retry_count)) {
          transitions.push({ at: Date.now(), state: row.state, retryCount: row.retry_count });
        }
      } catch {
        // the pool may be closing at the end of a run
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  })();
  return {
    transitions,
    sequence: () => transitions.map((t) => `${t.state}#${t.retryCount}`),
    async stop() {
      stopped = true;
      await loop;
    },
  };
}

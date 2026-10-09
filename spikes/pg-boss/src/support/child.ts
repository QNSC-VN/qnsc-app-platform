import { fork, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { Pool } from 'pg';
import type { Cluster } from './cluster.ts';
import type { WorkerConfig } from './worker-process.ts';

const WORKER_ENTRY = join(import.meta.dirname, 'worker-process.ts');

export interface WorkerHandle {
  readonly id: string;
  readonly proc: ChildProcess;
  /** Resolves with the exit signal/code when the process ends, however it ends. */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  signal(signal: NodeJS.Signals): void;
}

/**
 * Evidence table the child writes to: who started/finished/aborted which job, and when.
 * `clock_timestamp()`, not `now()`: `now()` is the transaction start and would flatten a log
 * written inside a long transaction.
 */
export const JOB_LOG_DDL = `
CREATE TABLE IF NOT EXISTS job_log (
  seq bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  worker text NOT NULL,
  event text NOT NULL,
  queue text,
  job_id uuid,
  retry_count int,
  message text
);
CREATE TABLE IF NOT EXISTS transcode_done (
  job_key text PRIMARY KEY,
  worker text NOT NULL,
  at timestamptz NOT NULL DEFAULT clock_timestamp()
);`;

export interface LogRow {
  at: Date;
  worker: string;
  event: string;
  queue: string | null;
  job_id: string | null;
  retry_count: number | null;
  message: string | null;
}

export async function logRows(
  pool: Pool,
  where = 'true',
  params: unknown[] = [],
): Promise<LogRow[]> {
  const { rows } = await pool.query<LogRow>(
    `SELECT at, worker, event, queue, job_id, retry_count, message FROM job_log WHERE ${where} ORDER BY seq`,
    params,
  );
  return rows;
}

/**
 * Start a worker as a real child process and resolve once it reports ready (queues registered,
 * polling started). Its environment is ONLY what a pod would have: DATABASE_* and the config.
 */
export async function spawnWorker(cluster: Cluster, config: WorkerConfig): Promise<WorkerHandle> {
  const proc = fork(WORKER_ENTRY, [], {
    env: {
      PATH: process.env['PATH'] ?? '',
      ...cluster.env,
      WORKER_CONFIG: JSON.stringify(config),
    },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    proc.once('exit', (code, signal) => resolve({ code, signal })),
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`worker ${config.id} did not become ready in 60 s`)),
      60_000,
    );
    proc.on('message', (message: { type?: string }) => {
      if (message.type === 'ready') {
        clearTimeout(timer);
        resolve();
      }
    });
    void exited.then(({ code, signal }) => {
      clearTimeout(timer);
      reject(new Error(`worker ${config.id} exited before ready (code ${code}, signal ${signal})`));
    });
  });
  return { id: config.id, proc, exited, signal: (s) => void proc.kill(s) };
}

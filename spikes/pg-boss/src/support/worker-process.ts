/**
 * A worker as it runs in a pod: its own OS process, its own platform-db pool, its own pg-boss
 * instance. The scenarios that kill or drain a worker (2, 7) and the one that needs two
 * replicas (4) cannot be honest with in-process instances: SIGKILL has to take the connections
 * with it, and SIGTERM has to arrive as a signal.
 *
 * Started with Node's own type stripping (`node worker-process.ts`) — no build, no tsx — so it
 * imports no module that needs a bundler: not `@quynhonsemiconductor/testing`, not vitest.
 * Configuration arrives as JSON in WORKER_CONFIG; the database through the same DATABASE_* env
 * a pod gets from the chart.
 */
import { createPool } from '@quynhonsemiconductor/platform-db';
import type { WorkOptions } from 'pg-boss';
import { createBoss } from './boss.ts';

export type HandlerKind =
  /** Sleeps `durationMs` in one-second steps, aborting when pg-boss aborts the job. */
  | { kind: 'sleep'; durationMs: number }
  /** A fake transcode: like `sleep`, then records ONE completion row guarded by `runOnce`. */
  | { kind: 'transcode'; durationMs: number }
  /** Resolves immediately. */
  | { kind: 'noop' }
  /** Load generator target: waits `ms` and writes nothing (no job_log row), batch run concurrently. */
  | { kind: 'busy'; ms: number }
  /** Throws, always. */
  | { kind: 'fail' };

export interface WorkerConfig {
  id: string;
  poolMax?: number;
  boss?: Record<string, unknown>;
  /** `boss.stop({ graceful: true, timeout })` on SIGTERM. */
  stopTimeoutMs?: number;
  handlers: { queue: string; handler: HandlerKind; work?: WorkOptions }[];
  /** Run these schedules' cron monitor (default true). */
  schedule?: boolean;
}

const config = JSON.parse(process.env['WORKER_CONFIG']!) as WorkerConfig;

const pool = createPool(process.env, { logger: { warn: console.error, error: console.error } });
const boss = createBoss(pool, {
  schedule: config.schedule ?? true,
  application_name: `worker-${config.id}`,
  ...config.boss,
  onError: (error) => log('pg-boss-error', { message: error.message }),
});

/** One line per event into `job_log`, so the parent can reconstruct who did what, when. */
async function log(
  event: string,
  fields: { queue?: string; jobId?: string; retryCount?: number; message?: string } = {},
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO job_log (worker, event, queue, job_id, retry_count, message)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        config.id,
        event,
        fields.queue ?? null,
        fields.jobId ?? null,
        fields.retryCount ?? null,
        fields.message ?? null,
      ],
    );
  } catch {
    // The log is evidence, not a dependency: a failing insert must not change the outcome.
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(
  handler: HandlerKind,
  queue: string,
  job: {
    id: string;
    retryCount: number;
    data: unknown;
    signal: AbortSignal;
  },
): Promise<void> {
  await log('start', { queue, jobId: job.id, retryCount: job.retryCount });
  switch (handler.kind) {
    case 'noop':
      break;
    case 'fail':
      throw new Error('this handler always fails');
    case 'sleep':
    case 'transcode': {
      // Abortable at once, not at the next poll of a loop: pg-boss aborts `job.signal` when the
      // shutdown grace runs out, and the listener issues its log insert synchronously so that
      // `pool.end()` cannot overtake it. pg-boss also aborts the signal after an ORDINARY
      // completion, so the listener is detached the moment the sleep ends.
      let detach = () => {};
      const aborted = new Promise<'aborted'>((resolve) => {
        const onAbort = () => {
          void log('aborted', { queue, jobId: job.id, retryCount: job.retryCount });
          resolve('aborted');
        };
        if (job.signal.aborted) onAbort();
        else {
          job.signal.addEventListener('abort', onAbort, { once: true });
          detach = () => job.signal.removeEventListener('abort', onAbort);
        }
      });
      const outcome = await Promise.race([
        sleep(handler.durationMs).then(() => 'done' as const),
        aborted,
      ]);
      detach();
      if (outcome === 'aborted') throw new Error('aborted: the worker is shutting down');
      if (handler.kind === 'transcode') {
        // The side effect, guarded: however often the job is delivered, one completion row.
        await pool.query(
          `INSERT INTO transcode_done (job_key, worker) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [(job.data as { asset: string }).asset, config.id],
        );
      }
      break;
    }
  }
  await log('finish', { queue, jobId: job.id, retryCount: job.retryCount });
}

await boss.start();
for (const { queue, handler, work } of config.handlers) {
  await boss.work(queue, { pollingIntervalSeconds: 1, ...work }, async (jobs) => {
    // pg-boss hands a batch. The product-facing API is per job: one at a time for the scenarios
    // that log each job, all at once for the load handler, which is what `concurrency` means.
    if (handler.kind === 'busy') {
      await Promise.all(jobs.map(() => sleep(handler.ms)));
      return undefined;
    }
    for (const job of jobs) await run(handler, queue, job);
    return undefined;
  });
}
await log('ready');
process.send?.({ type: 'ready', pid: process.pid });

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  await log('stop-begin', { message: signal });
  const started = Date.now();
  try {
    await boss.stop({ graceful: true, close: false, timeout: config.stopTimeoutMs ?? 30_000 });
  } finally {
    await log('stop-end', { message: `${Date.now() - started} ms` });
    await pool.end();
  }
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

/* eslint-disable @typescript-eslint/no-require-imports, no-undef --
 * A plain CommonJS script run by `fork()` against the built package, not part of the package:
 * `require` and the Node globals are exactly what it is.
 */
/**
 * A worker as it runs in a pod: its own OS process, its own pools, its own pg-boss instance. The
 * crash and heartbeat tests have to SIGKILL it, and a kill is only honest when it takes the
 * connections with it.
 *
 * Plain CommonJS against the BUILT package (`dist`), so it needs no bundler: build first.
 * Configuration arrives as JSON in CHILD_CONFIG, the database as the DATABASE_* a pod gets.
 */
const { createJobs, createJobsPool } = require('../../dist/index.js');
const { createPool } = require('@quynhonsemiconductor/platform-db');
const { createDatabase } = require('@quynhonsemiconductor/platform-db/drizzle');
const { sql } = require('drizzle-orm');

const config = JSON.parse(process.env.CHILD_CONFIG);
const env = { ...process.env, ROLE: 'worker' };

(async () => {
  const appPool = createPool(env);
  const db = createDatabase(appPool, { schema: {} });
  const jobsPool = createJobsPool(env);
  const jobs = createJobs({ pool: jobsPool, env });

  await jobs.handle(
    config.queue,
    async (job) => {
      // The side effect, guarded: however often the job is delivered, one row.
      await jobs.once(db, job.id, (tx) =>
        tx.execute(
          sql`INSERT INTO effects_done (key, worker) VALUES (${job.id}, ${config.worker})`,
        ),
      );
      // Tell the parent the job is running, then hang as a worker that is about to be killed.
      await appPool.query('INSERT INTO effects_done (key, worker) VALUES ($1, $2)', [
        `started:${job.id}`,
        config.worker,
      ]);
      await new Promise((resolve) => setTimeout(resolve, 10 * 60 * 1000));
    },
    config.options,
  );
  await jobs.start();
  if (process.send) process.send({ type: 'ready', pid: process.pid });
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

/* eslint-disable @typescript-eslint/no-require-imports, no-undef --
 * A plain CommonJS script run by `fork()` against the BUILT package, not part of the package:
 * `require` and the Node globals are exactly what it is.
 */
/**
 * A `mail.send` worker as it runs in a pod: its own OS process, its own pools, its own pg-boss. It
 * takes a message, claims it, starts "sending" and then HANGS inside the provider call — the
 * worker the test is about to SIGKILL. A kill is only honest when it takes the connections and the
 * claim-renewal timer with it, which is why this is a process and not a promise.
 *
 * Plain CommonJS against `dist`, so it needs no bundler: build first. The database arrives as the
 * DATABASE_* a pod gets; the Valkey URL in CHILD_CONFIG.
 */
const { createJobs, createJobsPool } = require('@quynhonsemiconductor/platform-jobs');
const { Redis } = require('ioredis');
const {
  MAIL_HANDLE_OPTIONS,
  MAIL_QUEUE,
  createMailHandler,
  createValkeyMailState,
} = require('../../dist/index.js');

const config = JSON.parse(process.env.CHILD_CONFIG);
const env = { ...process.env, ROLE: 'worker' };

(async () => {
  const redis = new Redis(config.valkeyUrl);
  const jobs = createJobs({ pool: createJobsPool(env), env });
  const hangingSender = {
    mailbox: config.mailbox,
    async send() {
      if (process.send) process.send({ type: 'sending', pid: process.pid });
      await new Promise(() => undefined); // the provider never answers; the process is killed
    },
  };
  await jobs.handle(
    MAIL_QUEUE,
    createMailHandler({ sender: hangingSender, state: createValkeyMailState(redis) }),
    MAIL_HANDLE_OPTIONS,
  );
  await jobs.start();
  if (process.send) process.send({ type: 'ready', pid: process.pid });
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

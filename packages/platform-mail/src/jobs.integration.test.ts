import { requestContextStorage } from '@quynhonsemiconductor/observability';
import { withTransaction } from '@quynhonsemiconductor/platform-db/drizzle';
import { drainQueue } from '@quynhonsemiconductor/platform-jobs/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dockerOn, jobRows, startMailJobsDb, type MailJobsDb } from './__helpers__/jobs-db';
import {
  MAIL_QUEUE,
  MAIL_QUEUE_CONFIG,
  createMailQueue,
  registerMailJobs,
  type MailQueue,
} from './jobs';
import { MemoryEmailSender, MemoryMailState, sampleMessage } from './testing';

/**
 * `platform-mail` on the REAL `platform-jobs` and PostgreSQL 18 (packages/testing), with the
 * roles production has. What is exercised is the queue itself — transactional enqueue, job-id
 * deduplication, retention, retries, the dead-letter queue, priority — not a stand-in for it.
 * Skipped without Docker locally; on CI a missing Docker fails the run.
 */
describe.skipIf(!dockerOn)('platform-mail on platform-jobs and PostgreSQL', () => {
  let env: MailJobsDb;
  const DLQ = 'mail.send.dlq';

  beforeAll(async () => {
    env = await startMailJobsDb();
  }, 180_000);
  afterAll(async () => {
    await env?.stop();
  }, 60_000);
  beforeEach(() => env.reset());

  // Every worker is closed after its test, passing or not: a worker left running would keep
  // taking the next test's jobs (they share the queue name) and send them to the wrong sender.
  const open: { close(): Promise<void> }[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((worker) => worker.close()));
  });

  /** A worker: real Jobs with ROLE=worker, the handler registered, started. */
  async function startWorker(sender = new MemoryEmailSender('noreply-academy@qnsc.vn')) {
    const made = env.makeJobs({ worker: true });
    // A simulated clock the pacing sleeps advance, so a burst of mail does not wait in real time.
    let now = 0;
    const state = new MemoryMailState(() => now);
    const queue = await registerMailJobs(made.jobs, {
      sender,
      state,
      sleep: async (ms) => {
        now += ms;
      },
    });
    await made.jobs.start();
    const worker = { ...made, sender, state, queue };
    open.push(worker);
    return worker;
  }

  const drain = (jobs: Parameters<typeof drainQueue>[0], queue: string = MAIL_QUEUE) =>
    drainQueue(jobs, queue);

  describe('enqueue and rollback', () => {
    it('rollback ⇒ no email, and no job', async () => {
      const worker = await startWorker();
      const message = sampleMessage({ idempotencyKey: 'rolled-back' });

      await expect(
        withTransaction(env.db, async (tx) => {
          expect(await worker.queue.enqueue(message, { tx })).not.toBeNull();
          throw new Error('the business step failed');
        }),
      ).rejects.toThrow('the business step failed');
      await drain(worker.jobs);

      expect(worker.sender.sent).toHaveLength(0);
      expect(await jobRows(env.adminPool, MAIL_QUEUE)).toHaveLength(0);
    });

    it('commit ⇒ exactly one email, and the job row is gone (completed: immediate)', async () => {
      const worker = await startWorker();

      await withTransaction(env.db, async (tx) => {
        await worker.queue.enqueue(sampleMessage({ idempotencyKey: 'committed' }), { tx });
        // Inside the transaction the job is not visible to anyone else yet.
        expect(await jobRows(env.adminPool, MAIL_QUEUE)).toHaveLength(0);
      });
      expect(await jobRows(env.adminPool, MAIL_QUEUE)).toHaveLength(1);
      await drain(worker.jobs);

      expect(worker.sender.sent).toHaveLength(1);
      // Auth mail carries bearer links: nothing of it stays once it was sent.
      expect(await jobRows(env.adminPool, MAIL_QUEUE)).toHaveLength(0);
    });

    it('an API pod that only enqueues defines the queue identically and the worker sends its mail', async () => {
      const api = env.makeJobs(); // ROLE unset: enqueue only
      open.push(api);
      const mailApi: MailQueue = await createMailQueue(api.jobs);
      await api.jobs.start();
      const worker = await startWorker(); // the worker defines it too, from the same MAIL_QUEUE_CONFIG

      const { rows } = await env.adminPool.query<{
        retry_limit: number;
        retry_delay: number;
        retry_delay_max: number;
        expire_seconds: number;
        heartbeat_seconds: number | null;
        dead_letter: string;
      }>(
        `SELECT retry_limit, retry_delay, retry_delay_max, expire_seconds, heartbeat_seconds, dead_letter
           FROM pgboss.queue WHERE name = $1`,
        [MAIL_QUEUE],
      );
      expect(rows[0]).toMatchObject({
        retry_limit: MAIL_QUEUE_CONFIG.retryLimit,
        retry_delay: MAIL_QUEUE_CONFIG.retryDelaySeconds,
        retry_delay_max: MAIL_QUEUE_CONFIG.retryDelayMaxSeconds,
        expire_seconds: MAIL_QUEUE_CONFIG.expireInSeconds,
        dead_letter: DLQ,
      });

      await mailApi.enqueue(sampleMessage({ idempotencyKey: 'from-api' }));
      await drain(worker.jobs);
      expect(worker.sender.sent).toHaveLength(1);
    });
  });

  describe('duplicate idempotency key ⇒ one email', () => {
    it('a second enqueue of a queued message inserts nothing', async () => {
      const worker = await startWorker();
      const message = sampleMessage({ idempotencyKey: 'verify-email:u1:abc' });

      expect(await worker.queue.enqueue(message)).not.toBeNull();
      expect(await worker.queue.enqueue(message)).toBeNull();
      await drain(worker.jobs);

      expect(worker.sender.sent).toHaveLength(1);
    });

    it('the same message enqueued AGAIN after it completed — the job row (and its dedupe) is gone — is still one email', async () => {
      const worker = await startWorker();
      const message = sampleMessage({ idempotencyKey: 'verify-email:u1:abc' });

      await worker.queue.enqueue(message);
      await drain(worker.jobs);
      expect(await jobRows(env.adminPool, MAIL_QUEUE)).toHaveLength(0);

      // The queue accepts it again (nothing remembers it there)...
      expect(await worker.queue.enqueue(message)).not.toBeNull();
      await drain(worker.jobs);

      // ...and the handler's ledger is what makes it one email.
      expect(worker.sender.sent).toHaveLength(1);
    });
  });

  describe('failures', () => {
    it('a permanent error ⇒ dead-lettered ONCE, with no retry', async () => {
      const worker = await startWorker();
      worker.sender.failNext({ kind: 'forbidden' });
      worker.sender.failNext({ kind: 'forbidden' }); // would be used by a (wrong) retry
      await worker.queue.enqueue(sampleMessage({ idempotencyKey: 'forbidden-mailbox' }));

      await drain(worker.jobs).catch(() => undefined);
      await drain(worker.jobs).catch(() => undefined); // a second pass finds nothing to retry

      const [job] = await jobRows(env.adminPool, MAIL_QUEUE);
      expect(job?.state).toBe('failed');
      expect(job?.retry_count).toBe(0); // no retry was spent
      expect(job?.output?.message).toContain('forbidden');
      expect(job?.output?.message).toContain('403');
      expect(await jobRows(env.adminPool, DLQ)).toHaveLength(1);
      expect(worker.sender.sent).toHaveLength(0);
      // Exactly one provider call happened: the second injected fault is still unused.
      await expect(worker.sender.send(sampleMessage())).rejects.toMatchObject({
        code: 'forbidden',
      });
    });

    it('a transient error ⇒ retried with backoff, claim released, and it is sent once', async () => {
      const worker = await startWorker();
      worker.sender.failNext({ kind: 'unavailable' });
      await worker.queue.enqueue(sampleMessage({ idempotencyKey: 'flaky' }));

      await drain(worker.jobs).catch(() => undefined);
      const [retrying] = await jobRows(env.adminPool, MAIL_QUEUE);
      expect(retrying?.state).toBe('retry');
      // pg-boss counts the retry when it starts it, so the count is still 0 while it waits.
      expect(retrying?.output?.message).toBe('Injected 503.');
      expect(retrying?.retry_limit).toBe(MAIL_QUEUE_CONFIG.retryLimit);
      expect(await jobRows(env.adminPool, DLQ)).toHaveLength(0);
      const waitMs = (retrying?.start_after.getTime() ?? 0) - Date.now();
      expect(waitMs).toBeGreaterThan(0); // backing off, not retried at once
      expect(worker.sender.sent).toHaveLength(0);

      // Fast-forward the backoff instead of waiting for it.
      await env.adminPool.query(`UPDATE pgboss.job SET start_after = now() WHERE name = $1`, [
        MAIL_QUEUE,
      ]);
      await drain(worker.jobs);

      expect(worker.sender.sent).toHaveLength(1);
      expect(await jobRows(env.adminPool, MAIL_QUEUE)).toHaveLength(0);
    });

    it('a throttled mailbox is backed off for the next job as well, and nothing is dead-lettered', async () => {
      const worker = await startWorker();
      worker.sender.failNext({ kind: 'throttled', retryAfterSeconds: 30 });
      await worker.queue.enqueue(sampleMessage({ idempotencyKey: 'throttled' }));

      await drain(worker.jobs).catch(() => undefined);

      const [job] = await jobRows(env.adminPool, MAIL_QUEUE);
      expect(job?.state).toBe('retry');
      expect(await jobRows(env.adminPool, DLQ)).toHaveLength(0);
      expect(await worker.state.takeSlot('noreply-academy@qnsc.vn')).toBeGreaterThan(25_000);
    });
  });

  describe('priority', () => {
    it('an auth message enqueued after 50 bulk messages is sent first', async () => {
      const worker = await startWorker();
      for (let i = 0; i < 50; i += 1) {
        await worker.queue.enqueue(
          sampleMessage({
            category: 'digest.daily',
            idempotencyKey: `bulk-${i}`,
            subject: `bulk ${i}`,
          }),
        );
      }
      await worker.queue.enqueue(
        sampleMessage({
          category: 'auth.reset-password',
          idempotencyKey: 'reset-1',
          subject: 'reset',
        }),
      );

      const rows = await jobRows(env.adminPool, MAIL_QUEUE);
      expect(rows).toHaveLength(51);
      expect(rows.filter((r) => r.priority === 10)).toHaveLength(1);

      await drain(worker.jobs);

      expect(worker.sender.sent).toHaveLength(51);
      expect(worker.sender.sent[0]?.subject).toBe('reset');
      expect(worker.sender.sent[0]?.category).toBe('auth.reset-password');
    }, 60_000);
  });

  describe('correlation id', () => {
    it('the worker continues the request’s correlation id from the payload', async () => {
      const sender = new MemoryEmailSender('noreply-academy@qnsc.vn');
      let seen: string | undefined;
      const send = sender.send.bind(sender);
      sender.send = async (message, options) => {
        seen = requestContextStorage.getStore()?.correlationId;
        return send(message, options);
      };
      const worker = await startWorker(sender);

      await worker.queue.enqueue(
        sampleMessage({ idempotencyKey: 'traced', correlationId: 'req-01HZX:abc.1' }),
      );
      await drain(worker.jobs);

      expect(seen).toBe('req-01HZX:abc.1');
    });
  });
});

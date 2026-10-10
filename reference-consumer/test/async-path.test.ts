import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Proc} from './support/process';
import { eventually, sleep } from './support/process';
import { Stack } from './support/stack';

/**
 * M6: plan criterion 9, the end-to-end async path, run against the PUBLISHED packages (identity 8.0.0,
 * platform-http 4.2.0, platform-jobs 0.1.1, platform-mail 0.1.1 and their peers, installed from the
 * registry) and not against stand-ins:
 *
 *   request (enableCorrelationId) -> identity sign-up -> mail.send enqueued in the SAME transaction
 *   -> a worker process (ROLE=worker) -> platform-mail's smtp transport -> Mailpit
 *
 * The API and the worker are separate OS processes running the compiled entries, with JSON logs on
 * stdout that the tests read: what is asserted is what an operator's collector would see.
 */
const stack = new Stack();
let worker: Proc;
const rand = () => randomBytes(4).toString('hex');
const address = (prefix: string) => `${prefix}-${rand()}@example.test`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeAll(async () => {
  await stack.start();
  worker = await stack.worker('worker-main');
});

afterAll(async () => {
  await stack.stop();
});

describe('one correlation id, request to delivered mail', () => {
  it('follows a sign-up from the HTTP request, through the job, to the delivered message', async () => {
    const email = address('happy');
    const id = `m6-happy-${rand()}`;

    const res = await stack.signUp(email, id);
    expect(res.status).toBe(200);
    // enableCorrelationId: kept, echoed.
    expect(res.headers.get('x-correlation-id')).toBe(id);

    // identity enqueued the mail through platform-jobs, JOINING the sign-up transaction, under this id.
    const enqueued = await stack.api.waitFor('jobs.send', 15_000, id);
    expect(enqueued).toMatchObject({ queue: 'mail.send', inTransaction: true });
    expect(typeof enqueued['jobId']).toBe('string');

    // The worker delivered exactly one message through platform-mail's smtp transport.
    const [mail] = await stack.mailTo(email, 1);
    expect(mail?.Subject).toBe('Verify your email');
    const delivered = await worker.waitFor('mail.send delivered', 20_000, id);

    // The same id, a different process: it can only have travelled in the job payload.
    expect(delivered.correlationId).toBe(id);
    // The job that was enqueued by the request is the job that was delivered...
    expect(delivered['jobId']).toBe(enqueued['jobId']);
    // ...and the delivered message is the one in the sink (Message-ID, with angle brackets in the log).
    expect(delivered['messageId']).toBe(`<${mail?.MessageID}>`);

    await sleep(2_000);
    expect(await stack.mailpit.messagesTo(email)).toHaveLength(1);
    expect(worker.find(/attempt failed/, id)).toEqual([]);
  });

  it('generates one when the caller sent none, and the same one reaches the worker', async () => {
    const email = address('generated');
    const res = await stack.signUp(email);
    expect(res.status).toBe(200);
    const id = res.headers.get('x-correlation-id') ?? '';
    expect(id).toMatch(UUID);

    await stack.mailTo(email, 1);
    const delivered = await worker.waitFor('mail.send delivered', 20_000, id);
    expect(delivered.correlationId).toBe(id);
  });

  it('never lets an invalid caller id reach a job payload or either process log', async () => {
    const email = address('invalid');
    const hostile = 'attack "with quotes" and spaces';
    const res = await stack.signUp(email, hostile);
    expect(res.status).toBe(200);
    const replaced = res.headers.get('x-correlation-id') ?? '';
    expect(replaced).toMatch(UUID);

    await stack.mailTo(email, 1);
    const delivered = await worker.waitFor('mail.send delivered', 20_000, replaced);
    expect(delivered.correlationId).toBe(replaced);
    // The rejected value is in no log line of either process.
    for (const proc of [stack.api, worker]) {
      expect(proc.raw.some((line) => line.includes('with quotes'))).toBe(false);
    }
  });
});

describe('rollback => no mail', () => {
  it('a sign-up that fails at COMMIT leaves no user, no job and no mail, though the job WAS enqueued in it', async () => {
    const email = `rollback-${rand()}@example.test`;
    const id = `m6-rollback-${rand()}`;

    const res = await stack.signUp(email, id);
    // The database refused the commit (an injected constraint trigger), after identity had enqueued.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.headers.get('x-correlation-id')).toBe(id);

    // Proof that this is a rollback and not an enqueue that never happened: the job was created, in the
    // sign-up's own transaction, before the failure.
    const enqueued = await stack.api.waitFor('jobs.send', 15_000, id);
    expect(enqueued).toMatchObject({ queue: 'mail.send', inTransaction: true });
    expect(typeof enqueued['jobId']).toBe('string');

    // Nothing of it survived: no user row, no job row (pending, active or dead-lettered).
    const users = await stack.admin.query('SELECT 1 FROM identity."user" WHERE email = $1', [email]);
    expect(users.rowCount).toBe(0);
    expect(await stack.jobsFor(email)).toEqual([]);

    // And no mail. Absence needs a control: once a LATER sign-up's mail has been delivered by the same
    // worker, an earlier one would long since have gone too.
    const control = address('control');
    expect((await stack.signUp(control)).status).toBe(200);
    await stack.mailTo(control, 1);
    expect(await stack.mailpit.messagesTo(email)).toHaveLength(0);
  });

  it('a product transaction that throws after mail.enqueue leaves no mail either', async () => {
    const to = address('product-rollback');
    const id = `m6-prb-${rand()}`;
    const res = await stack.notify({ to, key: `rb-${rand()}`, rollback: true }, id);
    expect(res.status).toBe(500);
    expect(res.headers.get('x-correlation-id')).toBe(id);

    // MailService.enqueue returned a job id inside the transaction that then threw.
    const enqueued = await stack.api.waitFor('notify enqueued', 5_000, id);
    expect(enqueued['rollback']).toBe(true);
    expect(enqueued['jobs']).toEqual([expect.any(String)]);

    expect(await stack.jobsFor(to)).toEqual([]);
    const control = address('control-2');
    await stack.notify({ to: control, key: `ctl-${rand()}` });
    await stack.mailTo(control, 1);
    expect(await stack.mailpit.messagesTo(to)).toHaveLength(0);
  });
});

describe('duplicate => one mail', () => {
  it('the same idempotency key enqueued three times in one transaction creates one job and one mail', async () => {
    const to = address('dup-tx');
    const key = `dup-${rand()}`;
    const id = `m6-dup-${rand()}`;
    const res = await stack.notify({ to, key, copies: 3 }, id);
    expect(res.status).toBe(201);
    const { jobs } = (await res.json()) as { jobs: (string | null)[] };
    // platform-jobs: a second send with the same key inserts nothing and resolves null.
    expect(jobs.filter((j) => j !== null)).toHaveLength(1);
    expect(jobs.filter((j) => j === null)).toHaveLength(2);

    await stack.mailTo(to, 1);
    await sleep(3_000);
    expect(await stack.mailpit.messagesTo(to)).toHaveLength(1);
  });

  it('two concurrent requests with the same key create one job and one mail', async () => {
    const to = address('dup-race');
    const key = `race-${rand()}`;
    const replies = await Promise.all([
      stack.notify({ to, key }, `m6-race-a-${rand()}`),
      stack.notify({ to, key }, `m6-race-b-${rand()}`),
    ]);
    const bodies = await Promise.all(replies.map((r) => r.json() as Promise<{ jobs: (string | null)[] }>));
    const created = bodies.flatMap((b) => b.jobs).filter((j) => j !== null);
    expect(created).toHaveLength(1);

    await stack.mailTo(to, 1);
    await sleep(3_000);
    expect(await stack.mailpit.messagesTo(to)).toHaveLength(1);
  });

  it('enqueuing the same key again AFTER the first mail was sent creates a job that sends nothing', async () => {
    // mail.send keeps no completed job (retention 'immediate'), and with it platform-jobs' job-id
    // dedupe. What stops a second mail now is platform-mail's own ledger in Valkey.
    const to = address('dup-after');
    const key = `after-${rand()}`;
    await stack.notify({ to, key }, `m6-first-${rand()}`);
    const [first] = await stack.mailTo(to, 1);
    await eventually(async () => {
      expect(await stack.jobsFor(to)).toEqual([]); // the completed job is gone: its dedupe went with it
    });

    const id = `m6-second-${rand()}`;
    const res = await stack.notify({ to, key }, id);
    const { jobs } = (await res.json()) as { jobs: (string | null)[] };
    expect(jobs[0]).toEqual(expect.any(String)); // a NEW job: platform-jobs could not dedupe it

    const skipped = await worker.waitFor('mail.send skipped: this message was already sent', 20_000, id);
    expect(skipped['messageId']).toBe(`<${first?.MessageID}>`);
    await sleep(2_000);
    expect(await stack.mailpit.messagesTo(to)).toHaveLength(1);
  });
});

describe('SIGTERM drain => no duplicate, none lost', () => {
  it('a worker told to stop while a send is in flight finishes it, hands the rest over, and nobody gets two', async () => {
    // Start from an idle system: stop the shared worker (itself a SIGTERM, on an empty queue).
    worker.signal('SIGTERM');
    expect((await worker.exited).code).toBe(0);

    // Six messages to six people, queued while NO worker runs.
    const people = Array.from({ length: 6 }, (_v, i) => address(`drain${i}`));
    for (const [i, to] of people.entries()) {
      const res = await stack.notify({ to, key: `drain-${rand()}-${i}` }, `m6-drain-${i}-${rand()}`);
      expect(res.status).toBe(201);
    }
    for (const to of people) expect(await stack.mailpit.messagesTo(to)).toHaveLength(0);

    // Worker A sends through a slowed SMTP connection, so a send takes seconds and can be caught in flight.
    stack.proxy.chunkDelayMs = 400;
    const proxyPort = (stack.proxy as unknown as { server: { address(): { port: number } } }).server.address().port;
    const a = await stack.worker('worker-A', { MAIL_SMTP_PORT: String(proxyPort), SHUTDOWN_TIMEOUT_MS: '25000' });

    await eventually(() => {
      if (stack.proxy.active < 1) throw new Error('no send in flight yet');
    }, { timeoutMs: 30_000, intervalMs: 25, what: 'a send in flight' });
    await sleep(700); // mid-session: after the connection, before the message is accepted
    const inFlightWhenTold = stack.proxy.active;
    expect(inFlightWhenTold).toBeGreaterThanOrEqual(1);

    const told = Date.now();
    a.signal('SIGTERM');
    const exit = await a.exited;
    const drainedInMs = Date.now() - told;

    // A clean drain: exit 0, well inside its budget, and the in-flight send was FINISHED, not cut off.
    expect(exit.code).toBe(0);
    expect(drainedInMs).toBeLessThan(25_000);
    const deliveredByA = a.find('mail.send delivered');
    expect(deliveredByA.length).toBeGreaterThanOrEqual(1);
    expect(deliveredByA.length).toBeLessThan(people.length); // it did NOT do everything: it handed over
    expect(a.find(/attempt failed/)).toEqual([]);

    // Worker B (direct to the sink) takes over exactly what A left.
    stack.proxy.chunkDelayMs = 0;
    const b = await stack.worker('worker-B');
    for (const to of people) await stack.mailTo(to, 1, 60_000);

    // Exactly one each: no duplicate (A's in-flight message was not re-sent by B), none lost.
    await sleep(3_000);
    for (const to of people) expect(await stack.mailpit.messagesTo(to), to).toHaveLength(1);

    // The two workers delivered disjoint sets of jobs that together are all of them.
    const jobsA = new Set(deliveredByA.map((l) => l['jobId']));
    const jobsB = new Set(b.find('mail.send delivered').map((l) => l['jobId']));
    expect([...jobsA].filter((j) => jobsB.has(j))).toEqual([]);
    expect(jobsA.size + jobsB.size).toBe(people.length);

    // Nothing was dead-lettered and nothing is left behind.
    for (const to of people) expect(await stack.jobsFor(to), to).toEqual([]);
    const dead = await stack.admin.query(`SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'mail.send.dlq'`);
    expect(dead.rows[0].n).toBe(0);
  });
});

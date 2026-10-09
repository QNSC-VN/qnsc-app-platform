import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { API, signIn, signUp, strongPassword, uniqueEmail, verifiedUser } from './support/flows';
import { mailIdempotencyKey, MAIL_QUEUE, type EmailMessage } from '../src/jobs/mail';
import { startStack, type Stack } from './support/stack';

/**
 * Criterion 9 — email callbacks (verification, reset) enqueue a `platform-jobs` job. Record
 * whether Better Auth runs these callbacks inside its database transaction; if it does not,
 * enqueue outside with an idempotent handler keyed by user, purpose and token hash.
 *
 * `StubJobs` stands in for platform-jobs (WP-7) with the §6.7 `jobs.send(queue, data, { tx,
 * idempotencyKey })` shape; `MailSendWorker` stands in for platform-mail's `mail.send` handler.
 */

async function jobsFor(stack: Stack, email: string) {
  const { rows } = await stack.pool.query<{ id: string; state: string; data: EmailMessage }>(
    `select id, state, data from spike_jobs where queue = $1 and data->>'to' = $2 order by created_at`,
    [MAIL_QUEUE, email],
  );
  return rows;
}

/** A deferred constraint trigger that makes COMMIT fail for addresses starting `poison+`. */
async function installPoison(stack: Stack): Promise<void> {
  await stack.pool.query(`
    create function identity.poison_check() returns trigger language plpgsql as $$
    begin
      if exists (select 1 from identity."user" u where u.id = new.user_id and u.email like 'poison+%') then
        raise exception 'poisoned commit for %', new.user_id;
      end if;
      return null;
    end $$;
    create constraint trigger poison after insert on identity.account
      deferrable initially deferred for each row execute function identity.poison_check();`);
}

describe('C9 email callbacks -> jobs: where do they run?', () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack();
    await installPoison(stack);
  });
  afterAll(async () => {
    await stack?.stop();
  });

  it("MEASUREMENT: which callbacks run inside Better Auth's transaction (adapter transaction:true, awaited)", async () => {
    const email = uniqueEmail('where');
    const password = strongPassword();
    const c = stack.client();
    await signUp(c, email, password); //                           -> verify-email callback
    await new Promise((r) => setTimeout(r, 1100));
    await signIn(c, email, password); //                           -> verify-email again (sendOnSignIn)
    await c.post(`${API}/send-verification-email`, { email }); //   -> verify-email, the "resend" button
    await c.post(`${API}/request-password-reset`, { email, redirectTo: '/r' }); // -> reset-password

    const seen = [...stack.mail.observations];
    const byFlow = seen.map((o) => `${o.purpose}:${o.inTransaction ? 'IN-TX' : 'outside'}`);
    console.info(`[C9] callback observations in order: ${byFlow.join(', ')}`);
    // sign-up (wrapped in runWithTransaction by Better Auth) is the ONE transactional callback
    expect(byFlow[0]).toBe('verify-email:IN-TX');
    // every other flow runs its callback outside any Better Auth transaction
    expect(byFlow.slice(1).every((x) => x.endsWith(':outside'))).toBe(true);
  });

  it('transactional enqueue: a sign-up whose COMMIT fails leaves no user, no account AND no job', async () => {
    const email = `poison+${crypto.randomUUID().slice(0, 8)}@example.test`;
    const res = await stack
      .client()
      .post(`${API}/sign-up/email`, { email, password: strongPassword(), name: 'P' });
    expect(res.status).toBeGreaterThanOrEqual(400); // the commit failed
    const users = await stack.pool.query(`select 1 from identity."user" where email = $1`, [email]);
    expect(users.rows).toHaveLength(0);
    expect(await jobsFor(stack, email)).toHaveLength(0);
  });

  it('a happy sign-up commits user, account and job together', async () => {
    const email = uniqueEmail('atomic');
    await signUp(stack.client(), email, strongPassword());
    expect(await jobsFor(stack, email)).toHaveLength(1);
    const users = await stack.pool.query(`select 1 from identity."user" where email = $1`, [email]);
    expect(users.rows).toHaveLength(1);
  });

  it('FINDING: a callback that THROWS is swallowed — sign-up succeeds, the user exists, no mail is queued', async () => {
    const email = uniqueEmail('swallow');
    const original = stack.jobs.send.bind(stack.jobs);
    stack.jobs.send = async () => {
      throw new Error('queue unavailable');
    };
    try {
      const res = await stack
        .client()
        .post(`${API}/sign-up/email`, { email, password: strongPassword(), name: 'S' });
      expect(res.status).toBe(200); // the client is told "check your email"
    } finally {
      stack.jobs.send = original;
    }
    const users = await stack.pool.query(`select 1 from identity."user" where email = $1`, [email]);
    expect(users.rows).toHaveLength(1);
    expect(await jobsFor(stack, email)).toHaveLength(0);
    // Recovery path is the resend: a correct-password sign-in re-sends (sendOnSignIn).
  });

  it('the handler: at-least-once delivery, exactly-one email (ledger keyed by idempotencyKey)', async () => {
    const email = uniqueEmail('twice');
    await signUp(stack.client(), email, strongPassword());
    const [job] = await jobsFor(stack, email);
    expect(await stack.worker.drain()).toBeGreaterThanOrEqual(1);
    const sentOnce = stack.sender.sent.filter((m) => m.to === email).length;
    expect(sentOnce).toBe(1);
    // the queue redelivers the SAME job (crash after send, before ack)
    await stack.pool.query(`update spike_jobs set state = 'created' where id = $1`, [job!.id]);
    await stack.worker.drain();
    expect(stack.sender.sent.filter((m) => m.to === email)).toHaveLength(1);
  });

  it('enqueue is idempotent: the same (purpose, user, token) twice is ONE job', async () => {
    const email = uniqueEmail('dedupe');
    await signUp(stack.client(), email, strongPassword());
    const [job] = await jobsFor(stack, email);
    const again = await stack.jobs.send(MAIL_QUEUE, job!.data, {
      idempotencyKey: job!.data.idempotencyKey,
    });
    expect(again).toBeNull();
    expect(await jobsFor(stack, email)).toHaveLength(1);
  });

  it('the idempotency key is purpose:user:sha256(token) and never contains the token', async () => {
    const email = uniqueEmail('key');
    const c = stack.client();
    await signUp(c, email, strongPassword());
    const [job] = await jobsFor(stack, email);
    const { rows } = await stack.pool.query<{ id: string }>(
      `select id from identity."user" where email = $1`,
      [email],
    );
    const token = new URL(job!.data.text).searchParams.get('token')!;
    expect(job!.data.idempotencyKey).toBe(mailIdempotencyKey('verify-email', rows[0]!.id, token));
    expect(job!.data.idempotencyKey).not.toContain(token);
  });

  it('FINDING: the job payload carries the bearer link, so job retention is a credential-retention decision', async () => {
    const email = uniqueEmail('payload');
    const c = await verifiedUser(stack, email, strongPassword());
    await c.post(`${API}/request-password-reset`, { email, redirectTo: '/r' });
    const rows = await jobsFor(stack, email);
    const reset = rows.find((r) => r.data.category === 'auth.reset-password')!;
    const token = new URL(reset.data.text).pathname.split('/').pop()!;
    // `verification.storeIdentifier: 'hashed'` protects the table; the job row holds the token in clear.
    expect(JSON.stringify(reset.data)).toContain(token);
  });

  it('awaiting the enqueue is cheap and does not leak whether the account exists (timing)', async () => {
    const known = uniqueEmail('t-known');
    await verifiedUser(stack, known, strongPassword());
    const time = async (email: string) => {
      const t = performance.now();
      await stack.client().post(`${API}/request-password-reset`, { email, redirectTo: '/r' });
      return performance.now() - t;
    };
    const k: number[] = [];
    const u: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      k.push(await time(known));
      u.push(await time(uniqueEmail('t-ghost')));
    }
    const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[2]!;
    console.info(
      `[C9 timing] request-password-reset known=${med(k).toFixed(1)}ms unknown=${med(u).toFixed(1)}ms`,
    );
    expect(Math.abs(med(k) - med(u))).toBeLessThan(25);
    void sql;
  });
});

describe('C9 fallback mode: enqueue OUTSIDE the transaction', () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack({ enqueueMode: 'outside' });
    await installPoison(stack);
  });
  afterAll(async () => {
    await stack?.stop();
  });

  it('a failed commit leaves an ORPHAN job: an email for an account that does not exist', async () => {
    const email = `poison+${crypto.randomUUID().slice(0, 8)}@example.test`;
    const res = await stack
      .client()
      .post(`${API}/sign-up/email`, { email, password: strongPassword(), name: 'P' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const users = await stack.pool.query(`select 1 from identity."user" where email = $1`, [email]);
    expect(users.rows).toHaveLength(0);
    expect(await jobsFor(stack, email)).toHaveLength(1); // <- the orphan
    await stack.worker.drain();
    expect(stack.sender.sent.some((m) => m.to === email)).toBe(true); // and it IS sent
  });
});

describe('C9 backgroundTasks.handler: callbacks stop being awaited', () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack({ identity: { spike: { backgroundEmail: true } } });
  });
  afterAll(async () => {
    await stack?.stop();
  });

  it('sign-up still enqueues, but the callback is no longer sequenced with the commit', async () => {
    const email = uniqueEmail('bg');
    const res = await stack
      .client()
      .post(`${API}/sign-up/email`, { email, password: strongPassword(), name: 'B' });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    const obs = stack.mail.observations.at(-1)!;
    const jobs = await jobsFor(stack, email);
    console.info(
      `[C9 background] callback saw a Better Auth tx: ${obs.inTransaction}; jobs enqueued: ${jobs.length}`,
    );
    // Recorded, not endorsed: with background tasks the transaction handle may already be closed
    // by the time the callback awaits anything. The ADR recommends against this combination.
    expect(jobs.length).toBeLessThanOrEqual(1);
  });
});

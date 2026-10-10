import { requestContextStorage } from '@quynhonsemiconductor/observability';
import {
  PermanentJobError,
  createJobs,
  type JobContext,
} from '@quynhonsemiconductor/platform-jobs';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { MailSendError } from './errors';
import {
  MAIL_CLAIM_LEASE_SECONDS,
  MAIL_CLAIM_RENEW_SECONDS,
  MAIL_HANDLE_OPTIONS,
  MAIL_MAX_SLOT_WAIT_MS,
  MAIL_PRIORITY,
  MAIL_QUEUE,
  MAIL_QUEUE_CONFIG,
  mailCanRedrive,
  MAIL_SENT_TTL_SECONDS,
  createMailHandler,
  createMailQueue,
  minRetryWindowSeconds,
  priorityFor,
  registerMailJobs,
  type MailLogger,
  type MailTelemetry,
} from './jobs';
import type { EmailMessage } from './message';
import { ledgerKey, type MailState } from './state';
import { MemoryEmailSender, MemoryMailState, sampleMessage } from './testing';

const MAILBOX = 'noreply-academy@qnsc.vn';

/** The handler and everything a test wants to look at, on the in-memory doubles. */
function setup(options: { state?: MailState } = {}) {
  const sender = new MemoryEmailSender(MAILBOX);
  let now = 0;
  const state = options.state ?? new MemoryMailState(() => now);
  const events: string[] = [];
  const telemetry: MailTelemetry = {
    sent: (category) => events.push(`sent:${category}`),
    duplicate: (category) => events.push(`duplicate:${category}`),
    failed: (category, code) => events.push(`failed:${category}:${code}`),
    paced: (ms) => events.push(`paced:${ms}`),
  };
  const logs: { level: string; fields: Record<string, unknown>; message: string }[] = [];
  const logger: MailLogger = {
    info: (fields, message) => logs.push({ level: 'info', fields, message }),
    warn: (fields, message) => logs.push({ level: 'warn', fields, message }),
    error: (fields, message) => logs.push({ level: 'error', fields, message }),
  };
  const sleeps: number[] = [];
  const handler = createMailHandler({
    sender,
    state,
    telemetry,
    logger,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms; // the simulated clock moves while a send waits for its slot
    },
  });
  const run = (data: unknown, extra: Partial<JobContext<EmailMessage>> = {}) =>
    handler({
      id: 'job-1',
      data: data as EmailMessage,
      attempt: 1,
      signal: new AbortController().signal,
      ...extra,
    });
  return { sender, state, events, logs, sleeps, run, advance: (ms: number) => (now += ms) };
}

const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
};

describe('mailCanRedrive: authentication mail is never redriven', () => {
  it.each([
    'auth.reset-password',
    'auth.verify-email',
    'auth.otp',
    'auth.',
    'AUTH.reset',
    'Auth.Verify',
  ])('forbids %s', (category) => {
    expect(mailCanRedrive({ category, to: ['a@example.test'] })).toBe(false);
  });

  it.each([
    'digest.daily',
    'notification.assigned',
    'invoice.sent',
    'authz.changed',
    'author.posted',
    'x',
  ])('allows %s (only the auth. namespace is forbidden, not a prefix of letters)', (category) => {
    expect(mailCanRedrive({ category })).toBe(true);
  });

  it.each([
    undefined,
    null,
    'text',
    7,
    [],
    {},
    { category: '' },
    { category: 7 },
    { category: null },
  ])('does not redrive what is not recognisably non-auth mail: %j', (data) => {
    expect(mailCanRedrive(data)).toBe(false);
  });

  it('is part of the queue definition, so the worker and every enqueue-only process share it', () => {
    expect(MAIL_QUEUE_CONFIG.canRedrive).toBe(mailCanRedrive);
    expect(MAIL_HANDLE_OPTIONS.canRedrive).toBe(mailCanRedrive);
  });

  it('agrees with the priority rule on what counts as auth (lower-case categories)', () => {
    for (const category of ['auth.reset', 'digest.daily', 'authz.x']) {
      expect(mailCanRedrive({ category })).toBe(priorityFor(category) === MAIL_PRIORITY.default);
    }
  });
});

describe('the mail.send queue configuration', () => {
  it('is ONE definition: the handler options are it, plus only the worker-side settings', () => {
    const { concurrency, pollingIntervalSeconds, ...queueSide } = MAIL_HANDLE_OPTIONS;
    expect(queueSide).toEqual(MAIL_QUEUE_CONFIG);
    expect(concurrency).toBe(1);
    expect(pollingIntervalSeconds).toBe(1);
  });

  it('deletes completed jobs at once and keeps failures and dead letters at most 24 h (ADR 0001 decision 3)', () => {
    expect(MAIL_QUEUE_CONFIG.retention).toEqual({
      completed: 'immediate',
      failed: 86_400,
      deadLetter: 86_400,
    });
    expect(Object.isFrozen(MAIL_QUEUE_CONFIG)).toBe(true);
    expect(Object.isFrozen(MAIL_QUEUE_CONFIG.retention)).toBe(true);
  });

  it('retries long enough that a ten-minute outage or sustained throttling cannot dead-letter auth mail', () => {
    // Worst case of pg-boss's jittered backoff: random() = 0 at every step.
    expect(minRetryWindowSeconds(MAIL_QUEUE_CONFIG)).toBeGreaterThanOrEqual(3_600);
    expect(MAIL_QUEUE_CONFIG.retryLimit).toBeGreaterThanOrEqual(1); // a drain costs one attempt
  });

  it('computes the window the way pg-boss backs off (delay × 2^n, capped)', () => {
    expect(
      minRetryWindowSeconds({ retryLimit: 4, retryDelaySeconds: 10, retryDelayMaxSeconds: 900 }),
    ).toBe(10 + 20 + 40 + 80);
    expect(
      minRetryWindowSeconds({ retryLimit: 4, retryDelaySeconds: 10, retryDelayMaxSeconds: 30 }),
    ).toBe(10 + 20 + 30 + 30);
  });

  it('sets the heartbeat explicitly instead of relying on the default', () => {
    expect(MAIL_QUEUE_CONFIG.heartbeatSeconds).toBe(30);
  });

  it('leases a claim for a minute and renews it twice per lease, so a dead worker’s claim lapses fast', () => {
    expect(MAIL_CLAIM_LEASE_SECONDS).toBe(60);
    expect(MAIL_CLAIM_RENEW_SECONDS).toBe(30);
    // Two ticks per lease: one missed renewal does not cost a live attempt its claim.
    expect(MAIL_CLAIM_LEASE_SECONDS).toBeGreaterThanOrEqual(2 * MAIL_CLAIM_RENEW_SECONDS);
    // ...and it is far shorter than the job's five-minute ceiling, which used to be the lease.
    expect(MAIL_CLAIM_LEASE_SECONDS).toBeLessThan(MAIL_QUEUE_CONFIG.expireInSeconds / 2);
  });

  it('keeps the ledger longer than the retry window plus the failed-job retention', () => {
    const outlive = minRetryWindowSeconds() * 4 + MAIL_QUEUE_CONFIG.retention.failed;
    expect(MAIL_SENT_TTL_SECONDS).toBeGreaterThan(outlive);
  });

  it('is accepted by platform-jobs, and a worker and an API pod define the queue identically', async () => {
    // No database: configuration is validated and fingerprinted when a queue is defined.
    const jobs = createJobs({
      pool: {} as Pool,
      env: { ROLE: 'worker' },
      logger: { warn() {}, error() {} },
    });
    const sender = new MemoryEmailSender(MAILBOX);

    await registerMailJobs(jobs, { sender, state: new MemoryMailState() }); // handle(): the worker's definition
    await expect(createMailQueue(jobs)).resolves.toBeDefined(); // defineQueue(): an API-only pod's definition
    // ...and a different definition of the same queue is refused.
    expect(() => jobs.defineQueue(MAIL_QUEUE, { ...MAIL_QUEUE_CONFIG, retryLimit: 3 })).toThrow(
      /defined twice/,
    );
  });
});

describe('createMailQueue', () => {
  function fakeJobs() {
    const send = vi.fn(async (..._args: unknown[]) => 'job-1' as string | null);
    const defineQueue = vi.fn(async (..._args: unknown[]) => undefined);
    return { send, defineQueue };
  }

  it('defines mail.send with MAIL_QUEUE_CONFIG before returning, so an API-only pod can send straight away', async () => {
    const jobs = fakeJobs();
    await createMailQueue(jobs);

    expect(jobs.defineQueue).toHaveBeenCalledWith(MAIL_QUEUE, MAIL_QUEUE_CONFIG);
  });

  it('passes the message, its idempotency key, the tx and the options to jobs.send', async () => {
    const jobs = fakeJobs();
    const queue = await createMailQueue(jobs);
    const message = sampleMessage({ idempotencyKey: 'verify-email:u1:abc' });
    const tx = { marker: 'tx' } as never;

    await queue.enqueue(message, { tx, startAfter: 5 });

    expect(jobs.send).toHaveBeenCalledWith(MAIL_QUEUE, message, {
      tx,
      startAfter: 5,
      priority: MAIL_PRIORITY.auth,
      idempotencyKey: 'verify-email:u1:abc',
    });
  });

  it('does not let a caller override the idempotency key through the options', async () => {
    const jobs = fakeJobs();
    const queue = await createMailQueue(jobs);
    await queue.enqueue(sampleMessage({ idempotencyKey: 'real' }), {
      idempotencyKey: 'forged',
    } as never);

    expect(jobs.send.mock.calls[0]?.[2]).toMatchObject({ idempotencyKey: 'real' });
  });

  it('validates BEFORE writing anything, so a bad message fails the caller transaction', async () => {
    const jobs = fakeJobs();
    const queue = await createMailQueue(jobs);

    await expect(queue.enqueue(sampleMessage({ to: [] }))).rejects.toMatchObject({
      code: 'invalid_message',
    });
    expect(jobs.send).not.toHaveBeenCalled();
  });

  it('resolves null for a message already queued (the jobs duplicate signal)', async () => {
    const jobs = fakeJobs();
    jobs.send.mockResolvedValueOnce(null);
    const queue = await createMailQueue(jobs);

    expect(await queue.enqueue(sampleMessage())).toBeNull();
  });

  describe('priority by category', () => {
    it.each([
      ['auth.verify-email', 10],
      ['auth.reset-password', 10],
      ['auth.anything-new', 10],
      ['digest.daily', 0],
      ['notification.assigned', 0],
      ['authorisation', 0], // not "auth." — a prefix match on the dot, not on letters
      ['x', 0],
    ])('%s ⇒ priority %i', async (category, priority) => {
      expect(priorityFor(category)).toBe(priority);
      const jobs = fakeJobs();
      await (await createMailQueue(jobs)).enqueue(sampleMessage({ category }));
      expect(jobs.send.mock.calls[0]?.[2]).toMatchObject({ priority });
    });

    it('lets the caller choose another priority', async () => {
      const jobs = fakeJobs();
      await (
        await createMailQueue(jobs)
      ).enqueue(sampleMessage({ category: 'digest.daily' }), { priority: 5 });
      expect(jobs.send.mock.calls[0]?.[2]).toMatchObject({ priority: 5 });
    });

    it('keeps bulk mail at 0 and auth well above it', () => {
      expect(MAIL_PRIORITY).toEqual({ auth: 10, default: 0 });
    });
  });
});

describe('duplicate idempotency key ⇒ one email', () => {
  it('redelivery of the same job ⇒ one email, the rest skipped', async () => {
    const { run, sender, events } = setup();
    const message = sampleMessage({ idempotencyKey: 'redelivered' });

    await run(message);
    await run(message);
    await run(message);

    expect(sender.sent).toHaveLength(1);
    expect(events.filter((e) => e.startsWith('duplicate:'))).toHaveLength(2);
  });

  it('the same message enqueued AGAIN after the first completed (job row deleted) ⇒ still one email', async () => {
    // With completed: 'immediate' the row — and the job-id dedupe with it — is gone. The ledger
    // is what stops the second one. (The queue-level half is in jobs.integration.test.ts.)
    const { run, sender } = setup();
    const message = sampleMessage({ idempotencyKey: 'verify-email:u1:abc' });

    await run(message, { id: 'first-job' });
    await run(message, { id: 'second-job' });

    expect(sender.sent).toHaveLength(1);
  });

  it('concurrent deliveries ⇒ one email; the losers fail retryably and then skip', async () => {
    const { run, sender } = setup();
    const message = sampleMessage({ idempotencyKey: 'racing' });

    const results = await Promise.allSettled([run(message), run(message), run(message)]);

    expect(sender.sent).toHaveLength(1);
    for (const result of results) {
      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(MailSendError);
        expect((result.reason as MailSendError).retryable).toBe(true);
        expect(result.reason).not.toBeInstanceOf(PermanentJobError);
      }
    }
    await run(message);
    expect(sender.sent).toHaveLength(1);
  });

  it('different keys are different emails', async () => {
    const { run, sender } = setup();
    await run(sampleMessage({ idempotencyKey: 'a' }));
    await run(sampleMessage({ idempotencyKey: 'b' }));
    expect(sender.sent).toHaveLength(2);
  });

  it('checks the ledger BEFORE the provider is called', async () => {
    const calls: string[] = [];
    const state = new MemoryMailState();
    const claim = state.claim.bind(state);
    state.claim = async (key, lease) => {
      calls.push('claim');
      return claim(key, lease);
    };
    const { run, sender } = setup({ state });
    const send = sender.send.bind(sender);
    sender.send = async (message, options) => {
      calls.push('send');
      return send(message, options);
    };

    await run(sampleMessage());
    expect(calls).toEqual(['claim', 'send']);
  });

  it('scopes the ledger to the mailbox: the same key from another mailbox is another email', () => {
    expect(ledgerKey('noreply-a@qnsc.vn', 'k')).not.toBe(ledgerKey('noreply-b@qnsc.vn', 'k'));
    expect(ledgerKey('NOREPLY-A@qnsc.vn', 'k')).toBe(ledgerKey('noreply-a@qnsc.vn', 'k'));
  });

  it('keys the ledger by a hash, never by the idempotency key itself', () => {
    const key = ledgerKey(MAILBOX, 'verify-email:0190f3a2:' + 'a'.repeat(64));
    expect(key).toMatch(/^mail:sent:[0-9a-f]{64}$/);
    expect(key).not.toContain('0190f3a2');
  });
});

describe('failures', () => {
  it('releases the claim after a transient failure, so the retry sends the message once', async () => {
    const { run, sender, events } = setup();
    const message = sampleMessage();
    sender.failNext({ kind: 'unavailable' });

    await expect(run(message)).rejects.toMatchObject({ code: 'unavailable' });
    await run(message, { attempt: 2 });

    expect(sender.sent).toHaveLength(1);
    expect(events).toEqual(['failed:auth.verify-email:unavailable', 'sent:auth.verify-email']);
  });

  it('a transient error reaches the queue as itself — retried, not dead-lettered', async () => {
    const { run, sender } = setup();
    sender.failNext({ kind: 'unavailable' });
    const error = await rejection(run(sampleMessage()));

    expect(error).toBeInstanceOf(MailSendError);
    expect(error).not.toBeInstanceOf(PermanentJobError);
  });

  it('a Valkey outage is retried, not dead-lettered, and sends nothing', async () => {
    const { run, sender, state } = setup();
    state.claim = async () => {
      throw new Error('valkey went away');
    };
    const error = await rejection(run(sampleMessage()));

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PermanentJobError);
    expect(sender.sent).toHaveLength(0);
  });

  it('a delivered message whose ledger write fails is NOT retried (retrying would send it again)', async () => {
    const { run, sender, state, logs } = setup();
    state.markSent = async () => {
      throw new Error('valkey went away');
    };

    await expect(run(sampleMessage())).resolves.toBeUndefined();

    expect(sender.sent).toHaveLength(1);
    expect(
      logs.some((l) => l.level === 'error' && /could not record it in the ledger/.test(l.message)),
    ).toBe(true);
  });

  it('a crashed attempt (claim never released) delays only until the lease ends', async () => {
    const { run, sender, state, advance } = setup();
    const message = sampleMessage({ idempotencyKey: 'crashed' });
    await state.claim(ledgerKey(MAILBOX, 'crashed'), MAIL_CLAIM_LEASE_SECONDS); // the dead worker's claim

    const error = await rejection(run(message));
    expect(error).toMatchObject({ retryable: true });
    expect(error).not.toBeInstanceOf(PermanentJobError);
    expect(sender.sent).toHaveLength(0);

    advance((MAIL_CLAIM_LEASE_SECONDS + 1) * 1000);
    await run(message, { attempt: 2 });
    expect(sender.sent).toHaveLength(1);
  });

  it('the stale claim of a killed worker is outlasted by the retry window, so its redelivery is never dead-lettered by it', () => {
    // Redelivery is bounced until the lease ends (≤ 60 s); the first retries are 10, 20, 40, 80 s.
    // The window dwarfs the lease.
    expect(minRetryWindowSeconds()).toBeGreaterThan(MAIL_CLAIM_LEASE_SECONDS * 5);
  });

  it('never logs the message content, recipients or subject', async () => {
    const { run, sender, logs } = setup();
    sender.failNext({ kind: 'unavailable' });
    const message = sampleMessage({
      to: 'private-person@example.test',
      subject: 'private subject',
      html: '<p>SECRET-LINK-TOKEN</p>',
    });
    await rejection(run(message));
    await run(message, { attempt: 2 });

    expect(JSON.stringify(logs)).not.toMatch(/private-person|private subject|SECRET-LINK-TOKEN/);
  });
});

describe('permanent failures dead-letter at once', () => {
  it.each([['forbidden', { kind: 'forbidden' } as const]])(
    '%s becomes a PermanentJobError carrying the code, the status and nothing else',
    async (code, fault) => {
      const { run, sender, events } = setup();
      sender.failNext(fault);
      const error = await rejection(run(sampleMessage({ to: 'private-person@example.test' })));

      expect(error).toBeInstanceOf(PermanentJobError);
      expect((error as Error).message).toContain(code);
      expect((error as Error).message).toContain('403');
      expect((error as Error).message).not.toContain('private-person');
      expect(events).toEqual([`failed:auth.verify-email:${code}`]);
    },
  );

  it.each([
    ['invalid_message', 400],
    ['forbidden', 403],
    ['mailbox_not_found', 404],
    ['too_large', 413],
  ] as const)('%s (HTTP %i) is permanent', async (code, status) => {
    const { run, sender } = setup();
    sender.send = async () => {
      throw new MailSendError(code, `Graph sendMail failed: HTTP ${status}`, { status });
    };

    expect(await rejection(run(sampleMessage()))).toBeInstanceOf(PermanentJobError);
  });

  it.each(['unauthenticated', 'throttled', 'unavailable', 'network', 'timeout'] as const)(
    '%s is NOT permanent: it is retried',
    async (code) => {
      const { run, sender } = setup();
      sender.send = async () => {
        throw new MailSendError(code, `x ${code}`);
      };

      expect(await rejection(run(sampleMessage()))).not.toBeInstanceOf(PermanentJobError);
    },
  );

  it('an invalid payload is permanent and calls neither the ledger nor the provider', async () => {
    const { run, sender, state, events } = setup();
    const claim = vi.spyOn(state, 'claim');

    expect(await rejection(run({ to: 'nobody' }))).toBeInstanceOf(PermanentJobError);
    expect(claim).not.toHaveBeenCalled();
    expect(sender.sent).toHaveLength(0);
    expect(events).toEqual(['failed:unknown:invalid_message']);
  });

  it('releases the claim, so a redrive from the dead-letter queue can send it', async () => {
    const { run, sender } = setup();
    const message = sampleMessage({ idempotencyKey: 'redrive' });
    sender.failNext({ kind: 'forbidden' });

    expect(await rejection(run(message))).toBeInstanceOf(PermanentJobError);
    await run(message);
    expect(sender.sent).toHaveLength(1);
  });
});

describe('pacing: about 20 messages a minute per mailbox', () => {
  it('lets a burst of 5 out at once, then spaces the rest 3 s apart', async () => {
    const { run, sender, sleeps } = setup();
    for (let i = 0; i < 8; i += 1) await run(sampleMessage({ idempotencyKey: `m${i}` }));

    expect(sender.sent).toHaveLength(8);
    expect(sleeps).toEqual([3_000, 3_000, 3_000]);
  });

  it('reports each wait to telemetry', async () => {
    const { run, events } = setup();
    for (let i = 0; i < 6; i += 1) await run(sampleMessage({ idempotencyKey: `m${i}` }));

    expect(events.filter((e) => e.startsWith('paced:'))).toHaveLength(1);
  });

  it('never sends more than 25 in any simulated minute', async () => {
    let clock = 0;
    const times: number[] = [];
    const sender = new MemoryEmailSender(MAILBOX);
    const send = sender.send.bind(sender);
    sender.send = async (message, options) => {
      times.push(clock);
      return send(message, options);
    };
    const handler = createMailHandler({
      sender,
      state: new MemoryMailState(() => clock),
      sleep: async (ms) => {
        clock += ms;
      },
    });
    for (let i = 0; i < 60; i += 1) {
      await handler({
        id: `j${i}`,
        data: sampleMessage({ idempotencyKey: `m${i}` }),
        attempt: 1,
        signal: new AbortController().signal,
      });
    }

    expect(sender.sent).toHaveLength(60);
    for (const start of times) {
      expect(times.filter((t) => t >= start && t < start + 60_000).length).toBeLessThanOrEqual(25);
    }
  });

  it('paces each mailbox on its own', async () => {
    const state = new MemoryMailState();
    const sleepsA: number[] = [];
    const handlerFor = (mailbox: string, sleeps: number[]) =>
      createMailHandler({
        sender: new MemoryEmailSender(mailbox),
        state,
        sleep: async (ms) => void sleeps.push(ms),
      });
    const job = (key: string) => ({
      id: key,
      data: sampleMessage({ idempotencyKey: key }),
      attempt: 1,
      signal: new AbortController().signal,
    });
    const a = handlerFor('noreply-rova@qnsc.vn', sleepsA);
    const b = handlerFor('noreply-opshub@qnsc.vn', []);
    for (let i = 0; i < 5; i += 1) await a(job(`a${i}`));
    await b(job('b0'));

    expect(sleepsA).toEqual([]); // A used its burst; B's bucket was untouched
    expect(await state.takeSlot('noreply-opshub@qnsc.vn')).toBe(0);
  });

  it('gives the job back (retryable throttled) rather than wait beyond the cap — and starts no cooldown for it', async () => {
    const state = new MemoryMailState();
    state.takeSlot = async () => MAIL_MAX_SLOT_WAIT_MS + 1;
    const backOff = vi.spyOn(state, 'backOff');
    const { run, sender } = setup({ state });

    const error = (await rejection(run(sampleMessage()))) as MailSendError;
    expect(error.code).toBe('throttled');
    expect(error.retryable).toBe(true);
    expect(error).not.toBeInstanceOf(PermanentJobError);
    expect(sender.sent).toHaveLength(0);
    // Our own pacing is not the provider throttling us.
    expect(backOff).not.toHaveBeenCalled();
  });

  it('releases the claim when the wait for a slot is interrupted, so the retry is not blocked', async () => {
    const state = new MemoryMailState();
    for (let i = 0; i < 5; i += 1) await state.takeSlot(MAILBOX);
    const sender = new MemoryEmailSender(MAILBOX);
    const handler = createMailHandler({
      sender,
      state,
      sleep: async () => {
        throw new Error('shutting down');
      },
    });

    await expect(
      handler({
        id: 'j',
        data: sampleMessage({ idempotencyKey: 'interrupted' }),
        attempt: 1,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('shutting down');
    expect((await state.claim(ledgerKey(MAILBOX, 'interrupted'), 30)).status).toBe('claimed');
  });
});

describe('a throttled mailbox is backed off for every worker', () => {
  it('records the provider’s Retry-After as a mailbox-wide cooldown, which the next send waits out', async () => {
    const { run, sender, state, sleeps } = setup();
    sender.failNext({ kind: 'throttled', retryAfterSeconds: 45 });

    const error = await rejection(run(sampleMessage({ idempotencyKey: 'first' })));
    expect(error).toMatchObject({ code: 'throttled' });
    expect(error).not.toBeInstanceOf(PermanentJobError);
    // The cooldown is visible to anyone asking for a slot, not only to this worker...
    const wait = await state.takeSlot(MAILBOX);
    expect(wait).toBeGreaterThan(44_000);
    expect(wait).toBeLessThanOrEqual(45_000);

    // ...and the next message's attempt sleeps through it before it sends.
    await run(sampleMessage({ idempotencyKey: 'second' }));
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(44_000);
    expect(sender.sent).toHaveLength(1);
  });

  it('uses a default when the provider gave no Retry-After, and caps an absurd one', async () => {
    const wait = async (retryAfterSeconds: number | undefined) => {
      const { run, state, sender } = setup();
      sender.send = async () => {
        throw new MailSendError('throttled', 'x', { status: 429, retryAfterSeconds });
      };
      await rejection(run(sampleMessage()));
      return state.takeSlot(MAILBOX);
    };

    expect(await wait(undefined)).toBeGreaterThan(59_000);
    expect(await wait(undefined)).toBeLessThanOrEqual(60_000);
    expect(await wait(86_400)).toBeLessThanOrEqual(600_000);
    expect(await wait(0)).toBeGreaterThan(0); // at least a second
  });

  it('does not back off for any other error', async () => {
    const { run, sender, state } = setup();
    const backOff = vi.spyOn(state, 'backOff');
    sender.failNext({ kind: 'unavailable' });
    await rejection(run(sampleMessage()));
    sender.failNext({ kind: 'forbidden' });
    await rejection(run(sampleMessage({ idempotencyKey: 'other' })));

    expect(backOff).not.toHaveBeenCalled();
  });

  it('a failing backOff does not mask the original error', async () => {
    const { run, sender, state } = setup();
    state.backOff = async () => {
      throw new Error('valkey went away');
    };
    sender.failNext({ kind: 'throttled' });

    expect(await rejection(run(sampleMessage()))).toMatchObject({ code: 'throttled' });
  });
});

describe('the request’s correlation id', () => {
  it('continues the id from the payload inside the send', async () => {
    const { run, sender } = setup();
    let seen: string | undefined;
    const send = sender.send.bind(sender);
    sender.send = async (message, options) => {
      seen = requestContextStorage.getStore()?.correlationId;
      return send(message, options);
    };

    await run(sampleMessage({ correlationId: '01HZX-req.123:abc' }));
    expect(seen).toBe('01HZX-req.123:abc');
  });

  it('leaves the ambient id alone when the payload has none', async () => {
    const { run, sender } = setup();
    let seen: string | undefined;
    const send = sender.send.bind(sender);
    sender.send = async (message, options) => {
      seen = requestContextStorage.getStore()?.correlationId;
      return send(message, options);
    };

    await requestContextStorage.run({ correlationId: 'mail.send:job-9' } as never, () =>
      run(sampleMessage()),
    );
    expect(seen).toBe('mail.send:job-9');
  });

  it.each(['has space', 'a'.repeat(129), 'crlf\r\ninjected', '', 'quote"d'])(
    'rejects %o as a permanent invalid payload instead of putting it in a log line',
    async (correlationId) => {
      const { run, sender, logs } = setup();

      expect(await rejection(run(sampleMessage({ correlationId })))).toBeInstanceOf(
        PermanentJobError,
      );
      expect(sender.sent).toHaveLength(0);
      expect(JSON.stringify(logs)).not.toContain('injected');
    },
  );
});

describe('registerMailJobs', () => {
  it('registers one handler on mail.send with MAIL_HANDLE_OPTIONS and returns the enqueue side', async () => {
    const handle = vi.fn(async (..._args: unknown[]) => undefined);
    const defineQueue = vi.fn(async (..._args: unknown[]) => undefined);
    const send = vi.fn(async (..._args: unknown[]) => 'job-1' as string | null);
    const queue = await registerMailJobs(
      { handle, defineQueue, send },
      { sender: new MemoryEmailSender(MAILBOX), state: new MemoryMailState() },
    );

    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle.mock.calls[0]?.[0]).toBe(MAIL_QUEUE);
    expect(handle.mock.calls[0]?.[2]).toBe(MAIL_HANDLE_OPTIONS);
    expect(await queue.enqueue(sampleMessage())).toBe('job-1');
  });
});

describe('the claim is renewed while a send runs, and lapses when its worker dies (M-A)', () => {
  /** A send that stays in flight until the test lets it finish. */
  function deferredSend(sender: MemoryEmailSender) {
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      const send = sender.send.bind(sender);
      sender.send = async (message, options) => {
        resolve();
        await new Promise<void>((r) => (release = r));
        return send(message, options);
      };
    });
    return { started, finish: () => release() };
  }

  it('renews on the interval while the send is in flight, with the lease, and stops when it ends', async () => {
    const state = new MemoryMailState();
    const renew = vi.spyOn(state, 'renew');
    const sender = new MemoryEmailSender(MAILBOX);
    const { started, finish } = deferredSend(sender);
    const handler = createMailHandler({ sender, state, claimRenewMs: 5 });
    const job = handler({
      id: 'j',
      data: sampleMessage(),
      attempt: 1,
      signal: new AbortController().signal,
    });
    await started;
    await new Promise((r) => setTimeout(r, 40));

    expect(renew.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(renew.mock.calls[0]?.[2]).toBe(MAIL_CLAIM_LEASE_SECONDS);
    finish();
    await job;
    const callsAtEnd = renew.mock.calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(renew.mock.calls.length).toBe(callsAtEnd); // the timer is gone with the attempt
  });

  it('a live attempt keeps its claim past the first lease: a second attempt still sees it in flight', async () => {
    let now = 0;
    const state = new MemoryMailState(() => now);
    const sender = new MemoryEmailSender(MAILBOX);
    const { started, finish } = deferredSend(sender);
    const message = sampleMessage({ idempotencyKey: 'long-send' });
    const handler = createMailHandler({ sender, state, claimRenewMs: 5 });
    const job = handler({
      id: 'j',
      data: message,
      attempt: 1,
      signal: new AbortController().signal,
    });
    await started;

    for (let i = 0; i < 4; i += 1) {
      await new Promise((r) => setTimeout(r, 20)); // a renewal happens
      now += (MAIL_CLAIM_LEASE_SECONDS - 10) * 1000; // 50 s of simulated time per round: 200 s in all
    }
    expect((await state.claim(ledgerKey(MAILBOX, 'long-send'), 30)).status).toBe('in-flight');
    finish();
    await job;
    expect(sender.sent).toHaveLength(1);
  });

  it('a dead attempt’s claim (never renewed) lapses within one lease, so the redelivery sends', async () => {
    let now = 0;
    const state = new MemoryMailState(() => now);
    const { run, sender } = setup({ state });
    await state.claim(ledgerKey(MAILBOX, 'killed'), MAIL_CLAIM_LEASE_SECONDS); // the dead worker's last claim
    const message = sampleMessage({ idempotencyKey: 'killed' });

    expect(await rejection(run(message))).toMatchObject({ retryable: true });
    now += (MAIL_CLAIM_LEASE_SECONDS + 1) * 1000;
    await run(message, { attempt: 2 });

    expect(sender.sent).toHaveLength(1);
  });

  it('a renewal that finds the claim gone is logged, and the attempt carries on', async () => {
    const state = new MemoryMailState();
    state.renew = async () => false;
    const logs: string[] = [];
    const sender = new MemoryEmailSender(MAILBOX);
    const { started, finish } = deferredSend(sender);
    const handler = createMailHandler({
      sender,
      state,
      claimRenewMs: 5,
      logger: { info() {}, error() {}, warn: (_f, message) => void logs.push(message) },
    });
    const job = handler({
      id: 'j',
      data: sampleMessage(),
      attempt: 1,
      signal: new AbortController().signal,
    });
    await started;
    await new Promise((r) => setTimeout(r, 30));
    finish();
    await job;

    expect(logs.some((m) => /lost its claim/.test(m))).toBe(true);
    expect(sender.sent).toHaveLength(1);
  });

  it('a renewal that throws does not fail the send', async () => {
    const state = new MemoryMailState();
    state.renew = async () => {
      throw new Error('valkey blinked');
    };
    const sender = new MemoryEmailSender(MAILBOX);
    const { started, finish } = deferredSend(sender);
    const handler = createMailHandler({ sender, state, claimRenewMs: 5 });
    const job = handler({
      id: 'j',
      data: sampleMessage(),
      attempt: 1,
      signal: new AbortController().signal,
    });
    await started;
    await new Promise((r) => setTimeout(r, 30));
    finish();

    await expect(job).resolves.toBeUndefined();
    expect(sender.sent).toHaveLength(1);
  });

  it('counts the in-flight bounce as mail.failures{code="in_flight"} and logs it', async () => {
    const { run, state, events, logs } = setup();
    await state.claim(ledgerKey(MAILBOX, 'busy'), MAIL_CLAIM_LEASE_SECONDS);

    const error = await rejection(run(sampleMessage({ idempotencyKey: 'busy' })));

    expect(error).toMatchObject({ code: 'unavailable', retryable: true });
    expect(error).not.toBeInstanceOf(PermanentJobError);
    expect(events).toEqual(['failed:auth.verify-email:in_flight']);
    expect(logs).toContainEqual({
      level: 'warn',
      fields: { jobId: 'job-1', category: 'auth.verify-email', code: 'in_flight', attempt: 1 },
      message: 'mail.send attempt failed',
    });
  });
});

describe('a 429 waited out inside send() still backs the whole mailbox off (M-B)', () => {
  it('tells the other workers BEFORE the wait: onThrottled gets the seconds, then the sender sleeps', async () => {
    const { run, sender, state } = setup();
    const order: string[] = [];
    const real = state.backOff.bind(state);
    state.backOff = async (mailbox, seconds) => {
      order.push(`backOff:${seconds}`);
      return real(mailbox, seconds);
    };
    sender.send = async (_message, options) => {
      order.push('429');
      await options?.onThrottled?.(20);
      order.push('slept');
      return { id: 'x', transport: 'memory' };
    };

    await run(sampleMessage());

    expect(order).toEqual(['429', 'backOff:20', 'slept']);
    // ...so another worker asking now is made to wait.
    expect(await state.takeSlot(MAILBOX)).toBeGreaterThan(19_000);
  });

  it('caps the cooldown it starts from the hook like any other', async () => {
    const { run, sender, state } = setup();
    sender.send = async (_message, options) => {
      await options?.onThrottled?.(86_400);
      return { id: 'x', transport: 'memory' };
    };
    await run(sampleMessage());

    expect(await state.takeSlot(MAILBOX)).toBeLessThanOrEqual(600_000);
  });

  it('a hook that cannot reach the state does not fail the send', async () => {
    const { run, sender, state } = setup();
    state.backOff = async () => {
      throw new Error('valkey blinked');
    };
    sender.send = async (_message, options) => {
      await Promise.resolve(options?.onThrottled?.(20)).catch(() => undefined);
      return { id: 'x', transport: 'memory' };
    };

    await expect(run(sampleMessage())).resolves.toBeUndefined();
  });
});

describe('an attempt aborted before the request is sent sends nothing (#195)', () => {
  /** A job whose signal a drain has already aborted. */
  const abortedJob = (data: EmailMessage) => ({
    id: 'draining',
    data,
    attempt: 1,
    signal: AbortSignal.abort(),
  });

  it('calls no transport at all — even one that ignores the signal — and releases the claim', async () => {
    const state = new MemoryMailState();
    let calls = 0;
    // A custom sender that does not look at the signal: the guarantee must not depend on it.
    const sender = {
      mailbox: MAILBOX,
      send: async () => {
        calls += 1;
        return { id: 'x', transport: 'custom' };
      },
    };
    const handler = createMailHandler({ sender, state });
    const message = sampleMessage({ idempotencyKey: 'drained-before-send' });

    const error = await rejection(handler(abortedJob(message)));

    expect(calls).toBe(0);
    expect(error).toMatchObject({ code: 'timeout', retryable: true });
    expect(error).not.toBeInstanceOf(PermanentJobError);
    // The claim was released: the retry, on another worker, can take it and send.
    expect((await state.claim(ledgerKey(MAILBOX, 'drained-before-send'), 30)).status).toBe(
      'claimed',
    );
  });

  it('does not start a send when the abort arrives during the wait for a slot', async () => {
    const state = new MemoryMailState();
    for (let i = 0; i < 5; i += 1) await state.takeSlot(MAILBOX); // the bucket is empty: the attempt must wait
    const controller = new AbortController();
    const sender = new MemoryEmailSender(MAILBOX);
    const handler = createMailHandler({
      sender,
      state,
      sleep: async () => {
        controller.abort(); // SIGTERM arrives while the attempt sleeps for its slot
        throw controller.signal.reason;
      },
    });

    await rejection(
      handler({
        id: 'j',
        data: sampleMessage({ idempotencyKey: 'drained-waiting' }),
        attempt: 1,
        signal: controller.signal,
      }),
    );

    expect(sender.sent).toHaveLength(0);
    expect((await state.claim(ledgerKey(MAILBOX, 'drained-waiting'), 30)).status).toBe('claimed');
  });

  it('is counted as a failed attempt, not as a duplicate or a success', async () => {
    const { events, sender } = setup();
    const handler = createMailHandler({
      sender,
      state: new MemoryMailState(),
      telemetry: {
        sent: (c) => events.push(`sent:${c}`),
        duplicate: (c) => events.push(`duplicate:${c}`),
        failed: (c, code) => events.push(`failed:${c}:${code}`),
        paced: () => undefined,
      },
    });
    await rejection(handler(abortedJob(sampleMessage())));

    expect(events).toEqual(['failed:auth.verify-email:timeout']);
    expect(sender.sent).toHaveLength(0);
  });
});

describe('a payload correlation id is validated before it becomes the log context (L-2)', () => {
  it.each([
    ['5028 characters with a newline', `${'a'.repeat(5000)}\n${'b'.repeat(27)}`],
    ['a newline', 'abc\ndef'],
    ['a space', 'a b'],
  ])(
    '%s is never entered as the context, never logged, and the payload dead-letters',
    async (_label, bad) => {
      const seenInContext: (string | undefined)[] = [];
      const logged: string[] = [];
      const handler = createMailHandler({
        sender: new MemoryEmailSender(MAILBOX),
        state: new MemoryMailState(),
        logger: {
          info() {},
          warn() {},
          error: (fields, message) => {
            // The line is written inside whatever context is current: it must not be the bad id.
            seenInContext.push(requestContextStorage.getStore()?.correlationId);
            logged.push(JSON.stringify({ fields, message }));
          },
        },
      });

      const error = await rejection(
        handler({
          id: 'j',
          data: sampleMessage({ correlationId: bad }),
          attempt: 1,
          signal: new AbortController().signal,
        }),
      );

      expect(error).toBeInstanceOf(PermanentJobError);
      expect(logged).toHaveLength(1);
      expect(seenInContext).not.toContain(bad);
      expect(logged.join('')).not.toContain('bbbb');
      expect(logged.join('')).not.toContain('abc\\ndef');
    },
  );

  it('a number is not coerced into an id: it fails validation instead of passing as "12345"', async () => {
    const { run, sender } = setup();
    expect(await rejection(run({ ...sampleMessage(), correlationId: 12345 }))).toBeInstanceOf(
      PermanentJobError,
    );
    expect(sender.sent).toHaveLength(0);
  });
});

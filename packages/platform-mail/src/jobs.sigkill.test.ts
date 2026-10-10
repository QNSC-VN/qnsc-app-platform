import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { dockerTestsEnabled, startValkey, type ValkeyHarness } from '@quynhonsemiconductor/testing';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { dockerOn, jobRows, startMailJobsDb, type MailJobsDb } from './__helpers__/jobs-db';
import {
  MAIL_CLAIM_LEASE_SECONDS,
  MAIL_QUEUE,
  createMailQueue,
  registerMailJobs,
  type MailTelemetry,
} from './jobs';
import { createValkeyMailState, ledgerKey } from './state';
import { MemoryEmailSender, sampleMessage } from './testing';

/**
 * The worker that dies mid-send. Real `platform-jobs`, PostgreSQL 18 and Valkey; the dying worker is
 * an OS process that is SIGKILLed while it holds the message's claim and its send is in flight.
 *
 * Before the claim was renewed, its 330 s lease outlived the worker: the job was recovered after ~77 s
 * (platform-jobs noticing the missed heartbeat) but every redelivery bounced off the dead worker's
 * claim, four of them, and the mail went out ~9 minutes after the kill — a 15-minute reset link with
 * six left. With a 60 s lease renewed every 30 s the claim lapses within a minute of the kill.
 *
 * It runs against `dist/` (the CI test job builds first) and takes about two minutes of real time:
 * the timeline IS the thing under test, so nothing here is sped up.
 */
const dist = join(import.meta.dirname, '..', 'dist', 'index.js');
const built = existsSync(dist);
const CHILD = join(import.meta.dirname, '__helpers__', 'worker-child.cjs');
const MAILBOX = 'noreply-academy@qnsc.vn';
const ALLOWED_AFTER_KILL_MS = 150_000;

const docker = dockerOn && (await dockerTestsEnabled());

describe.skipIf(!docker || !built)('a mail worker SIGKILLed mid-send', () => {
  let env: MailJobsDb;
  let valkey: ValkeyHarness;
  const children: ChildProcess[] = [];
  const clients: Redis[] = [];

  beforeAll(async () => {
    [env, valkey] = await Promise.all([startMailJobsDb(), startValkey()]);
  }, 180_000);
  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
  });
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.quit().catch(() => undefined)));
    await env?.stop();
    await valkey?.stop();
  }, 60_000);

  function message(child: ChildProcess, type: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const onMessage = (m: { type?: string }): void => {
        if (m.type === type) {
          child.off('message', onMessage);
          resolve();
        }
      };
      child.on('message', onMessage);
      child.once('exit', (code) =>
        reject(new Error(`worker child exited (${code}) before "${type}"`)),
      );
    });
  }

  it('its message is sent once, within about two and a half minutes of the kill, and nothing is dead-lettered', async () => {
    const redis = new Redis(valkey.url);
    clients.push(redis);
    const state = createValkeyMailState(redis);

    // The API pod defines the queue and enqueues.
    const api = env.makeJobs();
    const queue = await createMailQueue(api.jobs);
    await api.jobs.start();

    // The doomed worker: its own process, claiming and then hanging inside the provider call.
    const child = fork(CHILD, [], {
      env: {
        PATH: process.env['PATH'] ?? '',
        ...env.appEnv,
        CHILD_CONFIG: JSON.stringify({ valkeyUrl: valkey.url, mailbox: MAILBOX }),
      },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    children.push(child);
    await message(child, 'ready');

    await queue.enqueue(
      sampleMessage({ idempotencyKey: 'killed-mid-send', category: 'auth.reset-password' }),
    );
    await message(child, 'sending');
    // It holds the claim and is not done.
    expect((await state.claim(ledgerKey(MAILBOX, 'killed-mid-send'), 30)).status).toBe('in-flight');

    child.kill('SIGKILL');
    const killedAt = Date.now();

    // The replacement worker (another pod): a healthy sender, real timers, the real queue.
    const sender = new MemoryEmailSender(MAILBOX);
    const failures: string[] = [];
    const telemetry: MailTelemetry = {
      sent: () => undefined,
      duplicate: () => undefined,
      failed: (_category, code) => failures.push(code),
      paced: () => undefined,
    };
    const replacement = env.makeJobs({ worker: true });
    await registerMailJobs(replacement.jobs, { sender, state, telemetry });
    await replacement.jobs.start();

    let sentAt: number | undefined;
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline && sentAt === undefined) {
      if (sender.sent.length > 0) sentAt = Date.now();
      else await new Promise((r) => setTimeout(r, 500));
    }
    const afterKillMs = (sentAt ?? Date.now()) - killedAt;
    console.info(
      `SIGKILL probe: sent ${Math.round(afterKillMs / 1000)} s after the kill; ` +
        `failed attempts before it: ${JSON.stringify(failures)}`,
    );

    expect(sender.sent).toHaveLength(1);
    expect(afterKillMs).toBeLessThan(ALLOWED_AFTER_KILL_MS);
    // A claim of 330 s would have made this ~9 minutes; a 60 s one cannot outlast the kill by more.
    expect(MAIL_CLAIM_LEASE_SECONDS * 1000).toBeLessThan(ALLOWED_AFTER_KILL_MS);

    // No further send, nothing in the dead-letter queue, no job left.
    await new Promise((r) => setTimeout(r, 3_000));
    expect(sender.sent).toHaveLength(1);
    expect(await jobRows(env.adminPool, 'mail.send.dlq')).toHaveLength(0);
    expect(await jobRows(env.adminPool, MAIL_QUEUE)).toHaveLength(0);
    expect(failures.filter((code) => code === 'invalid_message' || code === 'forbidden')).toEqual(
      [],
    );

    await Promise.all([api.close(), replacement.close()]);
  }, 300_000);
});

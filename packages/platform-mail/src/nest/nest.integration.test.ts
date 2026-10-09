import 'reflect-metadata';
import { Module, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JOBS_TOKEN, JobsModule } from '@quynhonsemiconductor/platform-jobs/nest';
import { drainQueue } from '@quynhonsemiconductor/platform-jobs/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { dockerOn, jobRows, startMailJobsDb, type MailJobsDb } from '../__helpers__/jobs-db';
import { MAIL_QUEUE } from '../jobs';
import { MemoryEmailSender, MemoryMailState, sampleMessage } from '../testing';
import { MailModule, MailService } from './mail.module';

/**
 * The module in a real NestJS application beside the real `JobsModule`: `JobsModule` finds the
 * `@JobHandler`, registers it, starts pg-boss; `MailService` defines the queue and enqueues.
 */
describe.skipIf(!dockerOn)('MailModule with JobsModule and PostgreSQL', () => {
  let env: MailJobsDb;
  const contexts: INestApplicationContext[] = [];

  beforeAll(async () => {
    env = await startMailJobsDb();
  }, 180_000);
  afterEach(async () => {
    await Promise.all(contexts.splice(0).map((c) => c.close()));
    await env.reset();
  });
  afterAll(async () => {
    await env?.stop();
  }, 60_000);

  async function app(role: 'worker' | 'api') {
    const appEnv = { ...env.appEnv, ...(role === 'worker' ? { ROLE: 'worker' } : {}) };
    const sender = new MemoryEmailSender('noreply@example.test');
    @Module({
      imports: [
        JobsModule.forRoot({ env: appEnv }),
        MailModule.forRoot({ env: appEnv, sender, state: new MemoryMailState() }),
      ],
    })
    class AppModule {}
    const context = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
      abortOnError: false,
    });
    contexts.push(context);
    return { context, sender, mail: context.get(MailService), jobs: context.get(JOBS_TOKEN) };
  }

  it('a worker: enqueue through MailService, and the @JobHandler sends it', async () => {
    const { mail, jobs, sender } = await app('worker');

    expect(await mail.enqueue(sampleMessage({ idempotencyKey: 'via-nest' }))).not.toBeNull();
    await drainQueue(jobs, MAIL_QUEUE);

    expect(sender.sent).toHaveLength(1);
    expect(await jobRows(env.adminPool, MAIL_QUEUE)).toHaveLength(0);
  });

  it('an API pod enqueues without registering a handler; the worker sends', async () => {
    const api = await app('api');
    expect(
      await api.mail.enqueue(sampleMessage({ idempotencyKey: 'from-api-pod' })),
    ).not.toBeNull();
    expect(await jobRows(env.adminPool, MAIL_QUEUE)).toHaveLength(1);

    const worker = await app('worker');
    await drainQueue(worker.jobs, MAIL_QUEUE);

    expect(api.sender.sent).toHaveLength(0);
    expect(worker.sender.sent).toHaveLength(1);
  });
});

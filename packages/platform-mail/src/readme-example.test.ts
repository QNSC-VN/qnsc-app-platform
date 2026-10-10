import 'reflect-metadata';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { CacheModule, CacheService } from '@quynhonsemiconductor/platform-cache';
import { withTransaction } from '@quynhonsemiconductor/platform-db/drizzle';
import { startValkey, type ValkeyHarness } from '@quynhonsemiconductor/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dockerOn, jobRows, startMailJobsDb, type MailJobsDb } from './__helpers__/jobs-db';
import { createValkeyMailState } from './index';
import { MailModule } from './nest';
import { sampleMessage } from './testing';

/**
 * The README's NestJS example, BOOTED — not compiled, not paraphrased. The example in the README
 * once read `cache.instance` in a `useFactory`, where it is still `null` (`CacheService` connects
 * in `onModuleInit`, after Nest has built every provider), so every adopter who copied it failed
 * their first boot (issue #190). Two things keep that from coming back:
 *
 * 1. `__helpers__/readme-example.ts` IS the example, and the README block must equal it byte for
 *    byte, so the README cannot drift from what is booted here.
 * 2. That file is booted for real, against the BUILT package (its imports are the published
 *    names, resolved to `dist/`), a real Valkey, and PostgreSQL with the platform-jobs schema.
 *
 * Needs a build (the CI test job builds first) and Docker; locally each skips without one, on CI
 * a missing build or Docker fails the run.
 */
const root = join(import.meta.dirname, '..');
const built = existsSync(join(root, 'dist', 'index.js'));
const exampleFile = join(import.meta.dirname, '__helpers__', 'readme-example.ts');

function readmeExample(): string {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const section = readme.slice(readme.indexOf('\n## NestJS\n'));
  const match = /```ts\n([\s\S]*?)\n```/.exec(section);
  if (!match) throw new Error('README has no ts block under "## NestJS"');
  return match[1]!;
}

describe('the README NestJS example', () => {
  it('is exactly the file that is booted below', () => {
    expect(readmeExample()).toBe(readFileSync(exampleFile, 'utf8').trimEnd());
  });

  it.runIf(Boolean(process.env['CI']))('runs against a build on CI', () => {
    expect(built).toBe(true);
  });
});

describe.skipIf(!dockerOn || !built)('booting the README NestJS example', () => {
  let db: MailJobsDb;
  let valkey: ValkeyHarness;
  const saved: Record<string, string | undefined> = {};
  const set = (values: Record<string, string>): void => {
    for (const [key, value] of Object.entries(values)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
  };

  beforeAll(async () => {
    [db, valkey] = await Promise.all([startMailJobsDb(), startValkey()]);
    // The environment a pod has: the database, the cache, the worker role and a mail transport.
    // The Graph credential is generated: it does nothing until the first send.
    set({
      ...db.appEnv,
      ROLE: 'worker',
      NODE_ENV: 'test',
      REDIS_URL: valkey.url,
      MAIL_TRANSPORT: 'graph',
      MAIL_GRAPH_SENDER: 'noreply-academy@qnsc.vn',
      AZURE_TENANT_ID: '11111111-1111-1111-1111-111111111111',
      AZURE_CLIENT_ID: '22222222-2222-2222-2222-222222222222',
      AZURE_CLIENT_SECRET: 'generated-for-this-test',
    });
  }, 180_000);
  afterAll(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await db?.stop();
    await valkey?.stop();
  }, 60_000);
  beforeEach(() => db.reset());

  it('boots, and its SignUp enqueues in the caller’s transaction (rollback ⇒ no job, commit ⇒ one)', async () => {
    // Imported only now: `JobsModule.forRoot()` and `CacheModule.forRoot()` read the environment
    // when the module class is defined.
    const { AppModule, SignUp } = await import('./__helpers__/readme-example');
    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
      abortOnError: false,
    });
    try {
      const signUp = app.get(SignUp);

      await expect(
        withTransaction(db.db, async (tx) => {
          await signUp.register(sampleMessage({ idempotencyKey: 'readme-rollback' }), tx);
          throw new Error('the business step failed');
        }),
      ).rejects.toThrow('the business step failed');
      expect(await jobRows(db.adminPool, 'mail.send')).toHaveLength(0);

      await withTransaction(db.db, (tx) =>
        signUp.register(sampleMessage({ idempotencyKey: 'readme-commit' }), tx),
      );
      expect(await jobRows(db.adminPool, 'mail.send')).toHaveLength(1);
    } finally {
      await app.close();
    }
  }, 60_000);

  it('would NOT boot if it read cache.instance eagerly, which is why it does not (the control)', async () => {
    // If platform-cache ever connects before provider factories run, this stops failing and the
    // indirection in the README is obsolete: this test is how we find out.
    @Module({
      imports: [
        CacheModule.forRoot({ url: valkey.url, mode: 'required' }),
        MailModule.forRootAsync({
          inject: [CacheService],
          useFactory: (cache: CacheService) => ({ state: createValkeyMailState(cache.instance) }),
        }),
      ],
    })
    class EagerModule {}

    await expect(
      NestFactory.createApplicationContext(EagerModule, { logger: false, abortOnError: false }),
    ).rejects.toThrow(/client is not available/);
  }, 30_000);
});

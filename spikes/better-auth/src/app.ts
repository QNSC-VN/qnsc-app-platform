import 'reflect-metadata';
import { Controller, Get, Global, Inject, Module, type INestApplication } from '@nestjs/common';
import { NestFactory, APP_FILTER } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { CacheModule, CacheService } from '@quynhonsemiconductor/platform-cache';
import { DatabaseModule, DATABASE_TOKEN } from '@quynhonsemiconductor/platform-db/nest';
import type { DatabaseEnv } from '@quynhonsemiconductor/platform-db';
import type { DbExecutor } from '@quynhonsemiconductor/platform-db/drizzle';
import { GlobalExceptionFilter, REQUEST_CONTEXT } from '@quynhonsemiconductor/platform-http';
import * as schema from './db/schema';
import { createIdentity, type IdentityOptions, type Identity } from './identity/create-identity';
import { JobEmailPort, type EnqueueMode } from './identity/job-email-port';
import { StubJobs, type JobsApi } from './jobs/jobs-api';
import { MailSendWorker, MemorySender } from './jobs/mail';
import { IdentityModule } from './nest/identity.module';
import { AUTH, CurrentSession, Public, type RequestWithSession } from './nest/session.guard';

export const JOBS = Symbol('JOBS');
export const MAIL_PORT = Symbol('MAIL_PORT');
export const MAIL_SENDER = Symbol('MAIL_SENDER');
export const MAIL_WORKER = Symbol('MAIL_WORKER');

@Controller('v1')
class ProbeController {
  @Public()
  @Get('public')
  open(): { ok: true } {
    return { ok: true };
  }

  @Get('me')
  me(@CurrentSession() session: NonNullable<RequestWithSession['session']>) {
    return { id: session.user.id, email: session.user.email };
  }
}

export interface SpikeAppOptions {
  env: DatabaseEnv;
  valkeyUrl: string;
  keyPrefix: string;
  /** Fixed port: Better Auth needs its own origin (`baseURL`, `trustedOrigins`) before it listens. */
  port: number;
  /** Everything `createIdentity` takes that the test controls. */
  identity: Omit<IdentityOptions, 'db' | 'schema' | 'cache' | 'email'>;
  enqueueMode?: EnqueueMode;
}

export interface SpikeApp {
  app: NestFastifyApplication;
  url: string;
  auth: Identity;
  db: DbExecutor;
  cache: CacheService;
  jobs: JobsApi;
  mail: JobEmailPort;
  sender: MemorySender;
  worker: MailSendWorker;
  close(): Promise<void>;
}

/** Boots the real stack: platform-db + platform-cache + Better Auth on Fastify inside Nest 11. */
export async function bootSpikeApp(options: SpikeAppOptions): Promise<SpikeApp> {
  /** Stand-ins for `platform-jobs` / `platform-mail`: global, as those modules will be. */
  @Global()
  @Module({
    providers: [
      { provide: JOBS, inject: [DATABASE_TOKEN], useFactory: (db: DbExecutor) => new StubJobs(db) },
      {
        provide: MAIL_PORT,
        inject: [JOBS],
        useFactory: (jobs: JobsApi) =>
          new JobEmailPort(jobs, options.enqueueMode ?? 'transactional'),
      },
      { provide: MAIL_SENDER, useFactory: () => new MemorySender() },
      {
        provide: MAIL_WORKER,
        inject: [DATABASE_TOKEN, MAIL_SENDER],
        useFactory: (db: DbExecutor, sender: MemorySender) => new MailSendWorker(db, sender),
      },
    ],
    exports: [JOBS, MAIL_PORT, MAIL_SENDER, MAIL_WORKER],
  })
  class SpikeJobsModule {}

  @Module({
    imports: [
      CacheModule.forRoot({
        url: options.valkeyUrl,
        keyPrefix: options.keyPrefix,
        mode: 'required',
      }),
      DatabaseModule.forRootAsync({ schema, env: options.env }),
      SpikeJobsModule,
      IdentityModule.forRootAsync({
        inject: [DATABASE_TOKEN, CacheService, MAIL_PORT],
        useFactory: ((db: DbExecutor, cache: CacheService, email: JobEmailPort) =>
          createIdentity({ ...options.identity, db, schema, cache, email })) as never,
      }),
    ],
    controllers: [ProbeController],
    providers: [
      // The package's own filter; its REQUEST_CONTEXT dependency is stubbed to a fixed id.
      {
        provide: REQUEST_CONTEXT,
        useValue: { getCorrelationId: () => 'spike', getUserId: () => undefined },
      },
      { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    ],
  })
  class SpikeModule {}

  const app = await NestFactory.create<NestFastifyApplication>(
    SpikeModule,
    new FastifyAdapter({ trustProxy: false }),
    // Better Auth wants the raw body; Nest's parser is bypassed by the encapsulated mount.
    { logger: ['error'], bodyParser: false },
  );
  app.enableShutdownHooks();
  await app.listen(options.port, '127.0.0.1');

  return {
    app,
    url: `http://127.0.0.1:${options.port}`,
    auth: app.get<Identity>(AUTH),
    db: app.get<DbExecutor>(DATABASE_TOKEN),
    cache: app.get(CacheService),
    jobs: app.get<JobsApi>(JOBS),
    mail: app.get<JobEmailPort>(MAIL_PORT),
    sender: app.get<MemorySender>(MAIL_SENDER),
    worker: app.get<MailSendWorker>(MAIL_WORKER),
    close: () => (app as INestApplication).close(),
  };
}

void Inject;

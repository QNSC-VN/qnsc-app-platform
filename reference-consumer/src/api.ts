import 'reflect-metadata';
import { createIdentity, type JobEnqueue } from '@quynhonsemiconductor/identity';
import {
  AuthApiErrorFilter,
  identityLoggerFrom,
  IdentityModule,
  observabilitySecurityEvents,
  Public,
} from '@quynhonsemiconductor/identity/nest';
import {
  Body,
  Controller,
  Get,
  Inject,
  Logger as NestLogger,
  Module,
  Post,
} from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { RequestContextService } from '@quynhonsemiconductor/observability';
import { CacheService } from '@quynhonsemiconductor/platform-cache';
import { withTransaction, type DbExecutor } from '@quynhonsemiconductor/platform-db/drizzle';
import { DATABASE_TOKEN } from '@quynhonsemiconductor/platform-db/nest';
import {
  enableCorrelationId,
  GlobalExceptionFilter,
  HttpLoggingInterceptor,
  REQUEST_CONTEXT,
} from '@quynhonsemiconductor/platform-http';
import { currentCorrelationId, type Jobs } from '@quynhonsemiconductor/platform-jobs';
import { JOBS_TOKEN } from '@quynhonsemiconductor/platform-jobs/nest';
import { MailService } from '@quynhonsemiconductor/platform-mail/nest';
import { enableGracefulShutdown, enableHealth } from '@quynhonsemiconductor/platform-runtime';
import { Logger, PinoLogger } from 'nestjs-pino';
import { infraImports } from './infra';
import * as schema from './schema';

/**
 * Wraps the real `Jobs` so every enqueue leaves one log line: the queue, whether it joined a transaction,
 * and the job id it was given. A product would not necessarily do this; the tests need it to show that an
 * enqueue DID happen inside a transaction that later failed (a rollback test that cannot tell "never
 * enqueued" from "enqueued and rolled back" proves little). It forwards everything unchanged.
 */
function observed(jobs: Jobs): JobEnqueue {
  const log = new NestLogger('Enqueue');
  return {
    send: async (queue, data, options) => {
      const jobId = await jobs.send(queue, data, options);
      log.log({ msg: 'jobs.send', queue, jobId, inTransaction: options?.tx !== undefined });
      return jobId;
    },
  };
}

const BASE_URL = `http://127.0.0.1:${process.env['PORT'] ?? '0'}`;

/**
 * A product endpoint that enqueues mail through `MailService` directly: the duplicate and rollback
 * cases that identity's own routes cannot produce on demand. Same transaction rule as everywhere:
 * the mail job commits with the business write, or does not exist.
 */
@Controller('v1')
class NotifyController {
  private readonly log = new NestLogger('Notify');

  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: DbExecutor<typeof schema>,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(RequestContextService) private readonly context: RequestContextService,
  ) {}

  @Public()
  @Post('notify')
  async notify(
    @Body() body: { to: string; key: string; copies?: number; rollback?: boolean },
  ): Promise<{ jobs: (string | null)[]; correlationId: string | undefined }> {
    const ids: (string | null)[] = [];
    await withTransaction(this.db, async (tx) => {
      for (let i = 0; i < (body.copies ?? 1); i += 1) {
        ids.push(
          await this.mail.enqueue(
            {
              to: body.to,
              subject: `notify ${body.key}`,
              html: `<p>${body.key}</p>`,
              text: body.key,
              category: 'm6.notify',
              idempotencyKey: body.key,
              // Explicit, never injected (platform-jobs README): a payload that should continue the
              // request carries the id.
              ...(currentCorrelationId() ? { correlationId: currentCorrelationId() } : {}),
            },
            { tx },
          ),
        );
      }
      // Logged before the throw so a test can tell "enqueued, then rolled back" from "never enqueued".
      this.log.log({ msg: 'notify enqueued', jobs: ids, rollback: body.rollback === true });
      if (body.rollback) throw new Error('rolled back on purpose');
    });
    return { jobs: ids, correlationId: this.context.getCorrelationId() };
  }

  @Public()
  @Get('ctx')
  ctx(): { correlationId: string | undefined } {
    return { correlationId: this.context.getCorrelationId() };
  }
}

@Module({
  imports: [
    ...infraImports('m6-api'),
    IdentityModule.forRootAsync({
      inject: [DATABASE_TOKEN, CacheService, JOBS_TOKEN, PinoLogger],
      useFactory: ((db: DbExecutor, cache: CacheService, jobs: Jobs, authLogger: PinoLogger) => {
        authLogger.setContext('Identity');
        return createIdentity({
          product: 'm6',
          db,
          schema,
          cache,
          baseURL: BASE_URL,
          trustedOrigins: [BASE_URL],
          presets: ['public'],
          // Documented options (README "What a product writes"): Better Auth's warnings and errors, and the
          // security events, go through the product's logger.
          logger: identityLoggerFrom(authLogger),
          events: observabilitySecurityEvents(authLogger),
          // The real queue, the real transaction: `jobs` is platform-jobs, and its `send` takes the
          // `tx` identity passes.
          mail: {
            jobs: observed(jobs),
            templates: {
              verifyEmail: ({ user, url }) => ({
                subject: 'Verify your email',
                html: `<p>Hello ${user.name}</p><a href="${url}">verify</a>`,
                text: `verify: ${url}`,
              }),
              resetPassword: ({ url }) => ({
                subject: 'Reset your password',
                html: `<a href="${url}">reset</a>`,
                text: `reset: ${url}`,
              }),
            },
          },
        });
      }) as never,
    }),
  ],
  controllers: [NotifyController],
  providers: [
    { provide: REQUEST_CONTEXT, useExisting: RequestContextService },
    RequestContextService,
    { provide: APP_INTERCEPTOR, useClass: HttpLoggingInterceptor },
    // Order matters: Nest asks the LAST registered global filter first.
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    { provide: APP_FILTER, useClass: AuthApiErrorFilter },
  ],
})
class ApiModule {}

async function main(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    ApiModule,
    new FastifyAdapter({ trustProxy: false }),
    { bufferLogs: true },
  );
  app.useLogger(app.get(Logger));
  // The platform's request pipeline, in the documented order, before listen().
  enableCorrelationId(app);
  enableHealth(app);
  enableGracefulShutdown(app);
  await app.listen(Number(process.env['PORT'] ?? 0), '127.0.0.1');
  app.get(Logger).log({ msg: 'api ready', pid: process.pid });
}

main().catch((error: unknown) => {
  process.stderr.write(`api failed to start: ${String(error)}\n`);
  process.exit(1);
});

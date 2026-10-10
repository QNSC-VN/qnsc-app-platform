import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  Optional,
  type DynamicModule,
  type FactoryProvider,
  type ModuleMetadata,
  type OnModuleInit,
} from '@nestjs/common';
import {
  roleFrom,
  type JobContext,
  type JobHandlerFn,
  type Jobs,
  type SendOptions,
} from '@quynhonsemiconductor/platform-jobs';
import { JOBS_TOKEN, JobHandler } from '@quynhonsemiconductor/platform-jobs/nest';
import { isProduction, type MailEnv } from '../config';
import { createEmailSender } from '../factory';
import {
  MAIL_HANDLE_OPTIONS,
  MAIL_QUEUE,
  createMailHandler,
  createMailQueue,
  type MailLogger,
  type MailQueue,
} from '../jobs';
import type {
  EmailMessage,
  EmailSender,
  SendOptions as SendMailOptions,
  SendResult,
} from '../message';
import type { MailState } from '../state';
import { createMailTelemetry } from './telemetry';

/** DI tokens. `EMAIL_SENDER` is the one identity's `EmailSender` port binds to. */
export const EMAIL_SENDER = Symbol('EMAIL_SENDER');
export const MAIL_STATE = Symbol('MAIL_STATE');
const MAIL_ENV = Symbol('MAIL_ENV');

export interface MailModuleOptions {
  /** Test seam; defaults to `process.env`. Configuration comes from the environment only. */
  env?: MailEnv | undefined;
  /**
   * Use this sender instead of building one from the environment: a transport this package does
   * not have, or a test double. It must satisfy the `EmailSender` contract
   * (`describeEmailSenderConformance` checks that).
   *
   * **Refused when `NODE_ENV=production`** unless `allowCustomSenderInProduction` is true: it
   * bypasses every guard the built-in transports have (`smtp` refuses to load, a client secret is
   * refused), and a test double left in a production module drops every authentication email
   * while every health check stays green.
   */
  sender?: EmailSender | undefined;
  /**
   * Allow `sender` in production: a real transport this package does not have. Say it out loud;
   * the default is to refuse.
   */
  allowCustomSenderInProduction?: boolean | undefined;
  /**
   * The ledger and pacing store (`createValkeyMailState(cache.instance)`). Required in a
   * `ROLE=worker` process, which sends; an API process that only enqueues does not need it.
   */
  state?: MailState | undefined;
}

export interface MailModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  inject?: FactoryProvider['inject'];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- NestJS factory signature
  useFactory: (...args: any[]) => MailModuleOptions | Promise<MailModuleOptions>;
}

/** The sender for this module: the one given (outside production, or when allowed) or the built-in. */
function resolveSender(options: MailModuleOptions, env: MailEnv): EmailSender {
  if (options.sender === undefined) return createEmailSender({ env });
  if (isProduction(env) && options.allowCustomSenderInProduction !== true) {
    throw new Error(
      'MailModule: `sender` is refused when NODE_ENV=production. It bypasses the production guards ' +
        'of the built-in transports (a test double would silently drop every authentication email). ' +
        'Use MAIL_TRANSPORT=graph, or pass allowCustomSenderInProduction: true for a real transport ' +
        'of your own.',
    );
  }
  return options.sender;
}

function nestLogger(logger: Logger): MailLogger {
  return {
    info: (fields, message) => logger.log(fields, message),
    warn: (fields, message) => logger.warn(fields, message),
    error: (fields, message) => logger.error(fields, message),
  };
}

/**
 * The `mail.send` handler, as a provider with `@JobHandler`: `JobsModule` finds it at startup,
 * registers it BEFORE it starts pg-boss, and it runs only when `ROLE=worker`. Registering through
 * the decorator is what makes the order against `jobs.start()` a non-question.
 */
@Injectable()
export class MailSendHandler {
  private readonly handle: JobHandlerFn<EmailMessage> | undefined;

  constructor(
    @Inject(EMAIL_SENDER) sender: EmailSender,
    @Inject(MAIL_STATE) state: MailState | null,
    @Inject(MAIL_ENV) env: MailEnv,
  ) {
    if (state) {
      this.handle = createMailHandler({
        sender,
        state,
        telemetry: createMailTelemetry(),
        logger: nestLogger(new Logger('Mail')),
      });
    } else if (roleFrom(env as NodeJS.ProcessEnv) === 'worker') {
      // Fail the boot, not the first job: a worker without the ledger would send unguarded.
      throw new Error(
        'MailModule: ROLE=worker needs `state` (the idempotency ledger and pacing store). ' +
          'Pass createValkeyMailState(cache.instance).',
      );
    }
  }

  @JobHandler(MAIL_QUEUE, MAIL_HANDLE_OPTIONS)
  async send(job: JobContext<EmailMessage>): Promise<void> {
    if (!this.handle) throw new Error('MailModule has no `state`; it cannot send.');
    await this.handle(job);
  }
}

/**
 * What a product injects: `send()` for the "delivery must succeed before the step proceeds"
 * pattern (APP-PLATFORM-PLAN §4.3 case 2 — with its own ~5 s `signal`), `enqueue()` for
 * everything else.
 */
@Injectable()
export class MailService implements OnModuleInit {
  private queue: MailQueue | undefined;

  constructor(
    @Inject(EMAIL_SENDER) private readonly sender: EmailSender,
    @Optional() @Inject(JOBS_TOKEN) private readonly jobs?: Jobs,
  ) {}

  /** Defines `mail.send` in this process (an API pod included), identically to the worker. */
  async onModuleInit(): Promise<void> {
    if (this.jobs) this.queue = await createMailQueue(this.jobs);
  }

  /** Send now, through the transport. Callers that need a deadline pass `{ signal }`. */
  send(message: EmailMessage, options?: SendMailOptions): Promise<SendResult> {
    return this.sender.send(message, options);
  }

  /** Queue a message on `mail.send`; with `tx`, only if that transaction commits. */
  enqueue(
    message: EmailMessage,
    options?: Omit<SendOptions, 'idempotencyKey'>,
  ): Promise<string | null> {
    if (!this.queue) {
      throw new Error(
        'MailService.enqueue: no queue. Import JobsModule (platform-jobs/nest) so JOBS_TOKEN exists.',
      );
    }
    return this.queue.enqueue(message, options);
  }
}

@Global()
@Module({})
export class MailModule {
  static forRoot(options: MailModuleOptions = {}): DynamicModule {
    const env = options.env ?? process.env;
    return {
      module: MailModule,
      providers: [
        { provide: MAIL_ENV, useValue: env },
        { provide: MAIL_STATE, useValue: options.state ?? null },
        {
          provide: EMAIL_SENDER,
          useFactory: (): EmailSender => resolveSender(options, env),
        },
        MailSendHandler,
        MailService,
      ],
      exports: [EMAIL_SENDER, MailService],
    };
  }

  static forRootAsync(options: MailModuleAsyncOptions): DynamicModule {
    return {
      module: MailModule,
      imports: options.imports ?? [],
      providers: [
        { provide: 'MAIL_OPTIONS', useFactory: options.useFactory, inject: options.inject ?? [] },
        {
          provide: MAIL_ENV,
          useFactory: (resolved: MailModuleOptions): MailEnv => resolved.env ?? process.env,
          inject: ['MAIL_OPTIONS'],
        },
        {
          provide: MAIL_STATE,
          useFactory: (resolved: MailModuleOptions): MailState | null => resolved.state ?? null,
          inject: ['MAIL_OPTIONS'],
        },
        {
          provide: EMAIL_SENDER,
          useFactory: (resolved: MailModuleOptions, env: MailEnv): EmailSender =>
            resolveSender(resolved, env),
          inject: ['MAIL_OPTIONS', MAIL_ENV],
        },
        MailSendHandler,
        MailService,
      ],
      exports: [EMAIL_SENDER, MailService],
    };
  }
}

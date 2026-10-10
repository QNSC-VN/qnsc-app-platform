import 'reflect-metadata';
import { Module, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JOB_HANDLER_METADATA } from '@quynhonsemiconductor/platform-jobs/nest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAIL_HANDLE_OPTIONS, MAIL_QUEUE } from '../jobs';
import { MemoryEmailSender, MemoryMailState, sampleMessage } from '../testing';
import {
  EMAIL_SENDER,
  MailModule,
  MailSendHandler,
  MailService,
  type MailModuleOptions,
} from './mail.module';
import { assertNestPeers, missingPeerMessage } from './require-peers';
import { createMailTelemetry, MAIL_METRIC_NAMES } from './telemetry';

// Graph with a generated client secret: the real credential is constructed but does nothing
// until the first send, so a module can boot without a network or a token.
const ENV = {
  MAIL_TRANSPORT: 'graph',
  NODE_ENV: 'test',
  MAIL_GRAPH_SENDER: 'noreply@example.test',
  AZURE_TENANT_ID: '11111111-1111-1111-1111-111111111111',
  AZURE_CLIENT_ID: '22222222-2222-2222-2222-222222222222',
  AZURE_CLIENT_SECRET: 'generated-for-this-test',
};

const contexts: INestApplicationContext[] = [];
async function boot(options: MailModuleOptions): Promise<INestApplicationContext> {
  @Module({ imports: [MailModule.forRoot({ env: ENV, ...options })] })
  class AppModule {}
  const context = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
    abortOnError: false,
  });
  contexts.push(context);
  return context;
}
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((c) => c.close()));
});

describe('MailModule', () => {
  it('provides the EmailSender (the token identity binds its port to) and MailService', async () => {
    const context = await boot({});

    expect(context.get(EMAIL_SENDER).mailbox).toBe('noreply@example.test');
    expect(context.get(MailService)).toBeInstanceOf(MailService);
  });

  it('uses the sender it is given instead of building one from the environment', async () => {
    const sender = new MemoryEmailSender('custom@example.test');
    const context = await boot({ sender, env: { MAIL_TRANSPORT: 'cloudflare' } });

    expect(context.get(EMAIL_SENDER)).toBe(sender);
    await context.get(MailService).send(sampleMessage());
    expect(sender.sent).toHaveLength(1);
  });

  it('refuses to boot with a transport that is mis-configured, naming the variable', async () => {
    await expect(boot({ env: { MAIL_TRANSPORT: 'graph' } })).rejects.toThrow(/MAIL_GRAPH_SENDER/);
  });

  it('refuses to boot on smtp in production', async () => {
    await expect(boot({ env: { MAIL_TRANSPORT: 'smtp', NODE_ENV: 'production' } })).rejects.toThrow(
      /refused when NODE_ENV=production/,
    );
  });

  it('enqueue throws a clear error when platform-jobs is not part of the application', async () => {
    const mail = (await boot({})).get(MailService);
    expect(() => mail.enqueue(sampleMessage())).toThrow(/Import JobsModule/);
  });

  it('registers its handler through @JobHandler, so JobsModule does it before it starts pg-boss', () => {
    const handlerMethod = MailSendHandler.prototype.send;
    expect(Reflect.getMetadata(JOB_HANDLER_METADATA, handlerMethod)).toEqual({
      queue: MAIL_QUEUE,
      options: MAIL_HANDLE_OPTIONS,
    });
  });

  it('a ROLE=worker process without a state fails the boot, not the first job', async () => {
    await expect(boot({ env: { ...ENV, ROLE: 'worker' } })).rejects.toThrow(
      /ROLE=worker needs `state`/,
    );
  });

  it('an API process needs no state, and its handler refuses to run if it is ever called', async () => {
    const context = await boot({ env: { ...ENV, ROLE: 'api' } });
    await expect(
      context.get(MailSendHandler).send({ data: sampleMessage() } as never),
    ).rejects.toThrow(/no `state`/);
  });

  it('a worker with a state sends through the sender it was given', async () => {
    const sender = new MemoryEmailSender('noreply@example.test');
    const context = await boot({
      env: { ...ENV, ROLE: 'worker' },
      sender,
      state: new MemoryMailState(),
    });

    await context.get(MailSendHandler).send({
      id: 'j',
      data: sampleMessage(),
      attempt: 1,
      signal: new AbortController().signal,
    });
    expect(sender.sent).toHaveLength(1);
  });

  it('forRootAsync resolves its options from the container', async () => {
    const sender = new MemoryEmailSender('async@example.test');
    @Module({
      imports: [
        MailModule.forRootAsync({
          useFactory: () => ({ env: ENV, sender, state: new MemoryMailState() }),
        }),
      ],
    })
    class AsyncModule {}
    const context = await NestFactory.createApplicationContext(AsyncModule, {
      logger: false,
      abortOnError: false,
    });
    contexts.push(context);

    expect(context.get(EMAIL_SENDER)).toBe(sender);
  });
});

describe('a custom sender is refused in production (M-C)', () => {
  const PROD = {
    ...ENV,
    NODE_ENV: 'production',
    AZURE_CLIENT_SECRET: undefined,
    AZURE_FEDERATED_TOKEN_FILE: '/t',
  };

  it('forRoot refuses `sender` when NODE_ENV=production, and says why', async () => {
    await expect(
      boot({ env: PROD, sender: new MemoryEmailSender('x@example.test') }),
    ).rejects.toThrow(/`sender` is refused when NODE_ENV=production.*silently drop/s);
  });

  it('forRootAsync refuses it too', async () => {
    @Module({
      imports: [
        MailModule.forRootAsync({
          useFactory: () => ({ env: PROD, sender: new MemoryEmailSender('x@example.test') }),
        }),
      ],
    })
    class AsyncModule {}
    await expect(
      NestFactory.createApplicationContext(AsyncModule, { logger: false, abortOnError: false }),
    ).rejects.toThrow(/`sender` is refused when NODE_ENV=production/);
  });

  it('allows it only when `allowCustomSenderInProduction` is set — and then it must not be a MemoryEmailSender', async () => {
    const custom = {
      mailbox: 'real@example.test',
      send: async () => ({ id: 'x', transport: 'custom' }),
    };
    const context = await boot({ env: PROD, sender: custom, allowCustomSenderInProduction: true });
    expect(context.get(EMAIL_SENDER)).toBe(custom);
  });

  it('allowCustomSenderInProduction: false (or unset) still refuses', async () => {
    await expect(
      boot({
        env: PROD,
        sender: { send: async () => ({ id: 'x', transport: 'custom' }) },
        allowCustomSenderInProduction: false,
      }),
    ).rejects.toThrow(/refused/);
  });

  it('the built-in transport is unaffected in production', async () => {
    const context = await boot({ env: PROD });
    expect(context.get(EMAIL_SENDER).mailbox).toBe('noreply@example.test');
  });

  it('outside production a custom sender is accepted without the flag', async () => {
    await expect(
      boot({ env: ENV, sender: new MemoryEmailSender('x@example.test') }),
    ).resolves.toBeDefined();
  });
});

describe('createMailTelemetry', () => {
  function fakeMeter() {
    const calls: [string, string, number, object | undefined][] = [];
    const meter = {
      createCounter: (name: string) => ({
        add: (v: number, a?: object) => calls.push(['counter', name, v, a]),
      }),
      createHistogram: (name: string) => ({
        record: (v: number, a?: object) => calls.push(['histogram', name, v, a]),
      }),
    };
    return { calls, load: () => ({ getMeter: () => meter }) };
  }

  it('counts with bounded labels only', () => {
    const { calls, load } = fakeMeter();
    const telemetry = createMailTelemetry(load);
    telemetry.sent('auth.verify-email');
    telemetry.duplicate('auth.verify-email');
    telemetry.failed('auth.verify-email', 'throttled');
    telemetry.paced(3000);

    expect(calls).toEqual([
      ['counter', MAIL_METRIC_NAMES.sent, 1, { category: 'auth.verify-email' }],
      ['counter', MAIL_METRIC_NAMES.duplicates, 1, { category: 'auth.verify-email' }],
      [
        'counter',
        MAIL_METRIC_NAMES.failures,
        1,
        { category: 'auth.verify-email', code: 'throttled' },
      ],
      ['histogram', MAIL_METRIC_NAMES.pacingWaitMs, 3000, undefined],
    ]);
  });

  it('is a silent no-op when observability is not installed', () => {
    const telemetry = createMailTelemetry(() => {
      throw new Error("Cannot find module '@quynhonsemiconductor/observability'");
    });
    expect(() => {
      telemetry.sent('x');
      telemetry.failed('x', 'network');
      telemetry.paced(1);
    }).not.toThrow();
  });

  it('works with the real observability package', () => {
    expect(() => createMailTelemetry().sent('auth.verify-email')).not.toThrow();
  });
});

describe('/nest peers', () => {
  it('names @nestjs/common when it is missing', () => {
    expect(() =>
      assertNestPeers(() => {
        throw new Error('not found');
      }),
    ).toThrow(missingPeerMessage('@nestjs/common'));
  });

  it('passes when it resolves', () => {
    const resolve = vi.fn();
    expect(() => assertNestPeers(resolve)).not.toThrow();
    expect(resolve).toHaveBeenCalledWith('@nestjs/common');
  });
});

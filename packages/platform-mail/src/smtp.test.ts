import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSmtpServer } from './__helpers__/smtp-server';
import { createEmailSender } from './factory';
import { MailConfigError, type MailSendError } from './errors';
import * as smtpModule from './smtp';
import { createSmtpSender } from './smtp';
import {
  describeEmailSenderConformance,
  sampleMessage,
  type DeliveredMessage,
} from './testing/conformance';

const FROM = 'noreply@localhost.test';

function addresses(value: unknown): string[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.flatMap((entry: { value: { address: string }[] }) =>
    entry.value.map((v) => v.address),
  );
}

// The same conformance suite as graph and memory, against a real SMTP conversation.
describeEmailSenderConformance({
  name: 'smtp (fake SMTP server)',
  create: async () => {
    const smtp = new FakeSmtpServer();
    await smtp.start();
    return {
      sender: createSmtpSender({ host: '127.0.0.1', port: smtp.port, from: FROM }),
      delivered: async (): Promise<DeliveredMessage[]> =>
        smtp.received.map(({ parsed, rcptTo }) => {
          const to = addresses(parsed.to);
          const cc = addresses(parsed.cc);
          return {
            to,
            cc,
            // Bcc is never a header: it is the envelope recipients that appear in neither.
            bcc: rcptTo.filter((a) => !to.includes(a) && !cc.includes(a)),
            replyTo: addresses(parsed.replyTo)[0],
            subject: parsed.subject ?? '',
            html: String(parsed.html || ''),
            headers: Object.fromEntries(
              [...parsed.headers.entries()]
                .filter(([name]) => name.startsWith('x-'))
                .map(([name, value]) => [name, String(value)]),
            ),
          };
        }),
      cleanup: () => smtp.stop(),
    };
  },
});

describe('smtp transport', () => {
  let smtp: FakeSmtpServer;
  beforeEach(async () => {
    smtp = new FakeSmtpServer();
    await smtp.start();
  });
  afterEach(() => smtp.stop());

  it('sends HTML and the plain-text alternative from the configured mailbox', async () => {
    const sender = createSmtpSender({ host: '127.0.0.1', port: smtp.port, from: FROM });
    const result = await sender.send(sampleMessage({ html: '<p>hi</p>', text: 'hi' }));

    expect(result.transport).toBe('smtp');
    const [mail] = smtp.received;
    expect(mail?.mailFrom).toBe(FROM);
    expect(mail?.parsed.html).toBe('<p>hi</p>');
    expect(String(mail?.parsed.text).trim()).toBe('hi');
  });

  it('reports a 5xx reply as invalid_message, not retryable', async () => {
    smtp.rejectNext('550 mailbox unavailable');
    const error = (await createSmtpSender({ host: '127.0.0.1', port: smtp.port, from: FROM })
      .send(sampleMessage())
      .catch((e: unknown) => e)) as MailSendError;

    expect(error.code).toBe('invalid_message');
    expect(error.retryable).toBe(false);
  });

  it('reports a 4xx reply and a refused connection as network, retryable', async () => {
    smtp.rejectNext('451 try again later');
    const sender = createSmtpSender({ host: '127.0.0.1', port: smtp.port, from: FROM });
    const transient = (await sender
      .send(sampleMessage())
      .catch((e: unknown) => e)) as MailSendError;
    expect(transient.code).toBe('network');
    expect(transient.retryable).toBe(true);

    await smtp.stop();
    const refused = (await sender.send(sampleMessage()).catch((e: unknown) => e)) as MailSendError;
    expect(refused.code).toBe('network');
  });
});

describe('smtp transport refuses production', () => {
  it('the factory refuses MAIL_TRANSPORT=smtp when NODE_ENV=production', () => {
    expect(() =>
      createEmailSender({
        env: { MAIL_TRANSPORT: 'smtp', NODE_ENV: 'production' },
        loadSmtp: () => smtpModule,
      }),
    ).toThrow(MailConfigError);
  });

  it('the factory builds it outside production', () => {
    const sender = createEmailSender({
      env: { MAIL_TRANSPORT: 'smtp', NODE_ENV: 'development' },
      loadSmtp: () => smtpModule,
    });
    expect(sender.mailbox).toBe(FROM);
  });

  describe('loading the module', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    it('throws at load time when NODE_ENV=production, before nodemailer is required', async () => {
      vi.resetModules();
      vi.stubEnv('NODE_ENV', 'production');
      await expect(import('./smtp')).rejects.toThrow(/must not be loaded when NODE_ENV=production/);
    });

    it('loads when NODE_ENV is anything else', async () => {
      vi.resetModules();
      vi.stubEnv('NODE_ENV', 'test');
      await expect(import('./smtp')).resolves.toHaveProperty('createSmtpSender');
    });

    it('the package root can be imported in production without loading smtp', async () => {
      vi.resetModules();
      vi.stubEnv('NODE_ENV', 'production');
      const root = await import('./index');
      expect(root).toHaveProperty('createEmailSender');
      expect(root).not.toHaveProperty('createSmtpSender');
    });
  });
});

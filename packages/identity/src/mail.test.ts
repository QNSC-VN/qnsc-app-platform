import { describe, expect, it } from 'vitest';
import { perEmailLimiter } from './mail-limit';
import { AuthMail, mailIdempotencyKey } from './mail-port';
import { AUTH_MAIL_PRIORITY, MAIL_QUEUE, type JobSendOptions } from './ports';
import { assertTestLoginAllowed, TestLoginRefusedError } from './test-login';

const templates = {
  verifyEmail: ({ url }: { url: string }) => ({ subject: 'v', html: url, text: url }),
  resetPassword: ({ url }: { url: string }) => ({ subject: 'r', html: url, text: url }),
};

describe('mail', () => {
  it('the key is purpose:user:sha256(token) and never the token', () => {
    const key = mailIdempotencyKey('reset-password', 'u1', 'secret-token');
    expect(key).toMatch(/^reset-password:u1:[0-9a-f]{64}$/);
    expect(key).not.toContain('secret-token');
    expect(mailIdempotencyKey('verify-email', 'u1', 'secret-token')).not.toBe(key);
  });

  it('enqueues on mail.send with priority 10 and no retention option, and never awaits a provider', async () => {
    const sent: Array<{ queue: string; options: JobSendOptions | undefined }> = [];
    const mail = new AuthMail(
      { send: async (queue, _data, options) => (sent.push({ queue, options }), 'id') },
      templates,
    );
    await mail.sendVerification({
      user: { id: 'u', email: 'a@b.test', name: 'A' },
      url: 'https://x/verify',
      token: 't',
    });
    expect(sent[0]!.queue).toBe(MAIL_QUEUE);
    // priority, and NO per-send retention: platform-jobs has none, so it would be silently ignored
    expect(sent[0]!.options?.priority).toBe(AUTH_MAIL_PRIORITY);
    expect(Object.keys(sent[0]!.options ?? {}).sort()).toEqual([
      'idempotencyKey',
      'priority',
      'tx',
    ]);
    expect(sent[0]!.options?.idempotencyKey).toBe(mailIdempotencyKey('verify-email', 'u', 't'));
  });

  it('drops mail silently once an address is over its hourly cap', async () => {
    const counts = new Map<string, number>();
    const allow = perEmailLimiter({
      increment: (k) => (counts.set(k, (counts.get(k) ?? 0) + 1), counts.get(k)!),
    });
    const results = [];
    for (let i = 0; i < 5; i += 1) results.push(await allow('reset-password', 'A@B.test'));
    expect(results).toEqual([true, true, true, false, false]);
    expect(await allow('reset-password', 'other@b.test')).toBe(true);
    expect(await allow('verify-email', 'a@b.test')).toBe(true); // separate budget per purpose
  });

  it('test-login needs the explicit switch and refuses production', () => {
    expect(() =>
      assertTestLoginAllowed({ IDENTITY_TEST_LOGIN: 'enabled', NODE_ENV: 'test' }),
    ).not.toThrow();
    expect(() =>
      assertTestLoginAllowed({ IDENTITY_TEST_LOGIN: 'enabled', NODE_ENV: 'development' }),
    ).not.toThrow();
    expect(() => assertTestLoginAllowed({})).toThrow(TestLoginRefusedError);
    for (const NODE_ENV of [undefined, '', 'staging', 'prod', 'Production', 'qa']) {
      expect(() => assertTestLoginAllowed({ IDENTITY_TEST_LOGIN: 'enabled', NODE_ENV })).toThrow(
        /NODE_ENV/,
      );
    }
    expect(() => assertTestLoginAllowed({ IDENTITY_TEST_LOGIN: 'true', NODE_ENV: 'test' })).toThrow(
      /not "enabled"/,
    );
    expect(() =>
      assertTestLoginAllowed({ IDENTITY_TEST_LOGIN: 'enabled', NODE_ENV: 'production' }),
    ).toThrow(/NODE_ENV/);
  });
});

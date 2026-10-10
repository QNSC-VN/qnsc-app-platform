import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, sleep } from './support/process';
import { Stack } from './support/stack';

/**
 * CHARACTERIZATION of what the published packages do at their documented limits. Slow (minutes), so
 * opt-in: `M6_SLOW=1 pnpm test`. These assert today's behaviour; if one starts failing because the
 * limit was fixed, flip the assertion and close the issue it names.
 */
const slow = process.env['M6_SLOW'] === '1';
const rand = () => randomBytes(3).toString('hex');
const address = (prefix: string) => `${prefix}-${rand()}@example.test`;
const stack = new Stack();

beforeAll(async () => {
  if (slow) await stack.start();
});
afterAll(async () => {
  if (slow) await stack.stop();
});

const proxyPort = () =>
  (stack.proxy as unknown as { server: { address(): { port: number } } }).server.address().port;

describe.skipIf(!slow)('known limits (opt-in: M6_SLOW=1)', () => {
  it('a drain that runs OUT OF BUDGET after the sink stored the message but before the client heard it sends it twice', async () => {
    const to = address('lost-ack');
    await stack.notify({ to, key: `ack-${rand()}` }, 'limit-ack');

    // The sink stores the message at once; the acknowledgement is held for 20 s. The drain budget of a
    // worker is SHUTDOWN_TIMEOUT_MS - 3 s = 3 s, so it ends first.
    stack.proxy.ackDelayMs = 20_000;
    const a = await stack.worker('worker-A', {
      MAIL_SMTP_PORT: String(proxyPort()),
      SHUTDOWN_TIMEOUT_MS: '6000',
    });
    await eventually(
      async () => {
        if ((await stack.mailpit.messagesTo(to)).length < 1) throw new Error('not stored yet');
      },
      { timeoutMs: 30_000, intervalMs: 100, what: 'the sink to hold the message' },
    );
    a.signal('SIGTERM');
    expect((await a.exited).code).toBe(0); // it shut down "cleanly", having failed the job it could not finish
    expect(await stack.mailpit.messagesTo(to)).toHaveLength(1);

    stack.proxy.ackDelayMs = 0;
    await stack.worker('worker-B');
    // platform-mail's claim lease (60 s) must lapse before the retry can send: about two minutes in all.
    await stack.mailTo(to, 2, 170_000);
    await sleep(2_000);
    // At-least-once, as documented ("what it cannot do"): the second copy IS delivered.
    expect(await stack.mailpit.messagesTo(to)).toHaveLength(2);
  });

  it('a worker killed (SIGKILL) mid-send never causes a duplicate, but a stuck message waits for recovery', async () => {
    const people = Array.from({ length: 3 }, (_v, i) => address(`kill${i}`));
    for (const [i, to] of people.entries()) await stack.notify({ to, key: `kill-${rand()}-${i}` });

    stack.proxy.chunkDelayMs = 400;
    const a = await stack.worker('worker-C', { MAIL_SMTP_PORT: String(proxyPort()) });
    await eventually(
      () => {
        if (stack.proxy.active < 1) throw new Error('no send in flight');
      },
      { timeoutMs: 30_000, intervalMs: 25, what: 'a send in flight' },
    );
    await sleep(700);
    a.signal('SIGKILL');
    await a.exited;

    stack.proxy.chunkDelayMs = 0;
    await stack.worker('worker-D');
    const started = Date.now();
    for (const to of people) await stack.mailTo(to, 1, 170_000);
    const seconds = (Date.now() - started) / 1000;
    await sleep(2_000);
    for (const to of people) expect(await stack.mailpit.messagesTo(to), to).toHaveLength(1);
    // Documented recovery: a heartbeat plus the supervisor's monitor pass, about 75 s, and the claim lease.
    expect(seconds).toBeLessThan(170);
  });
});

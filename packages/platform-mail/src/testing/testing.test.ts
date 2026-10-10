import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MemoryEmailSender,
  MemoryMailState,
  describeEmailSenderConformance,
  describeMailStateConformance,
  sampleMessage,
} from './index';

// The in-memory sender passes the same suite as the real transports...
describeEmailSenderConformance({
  name: 'MemoryEmailSender',
  create: () => {
    const sender = new MemoryEmailSender('noreply@example.test');
    return {
      sender,
      delivered: async () =>
        sender.sent.map((m) => ({
          to: m.to,
          cc: m.cc,
          bcc: m.bcc,
          replyTo: m.replyTo,
          subject: m.subject,
          html: m.html,
          headers: m.headers,
        })),
      failNext: (fault) =>
        sender.failNext(
          fault.kind === 'throttled'
            ? { kind: 'throttled', retryAfterSeconds: fault.retryAfterSeconds }
            : fault,
        ),
    };
  },
});

// ...and the in-memory state passes the MailState suite, with a clock the test controls.
let clock = 1_000_000;
describeMailStateConformance({
  name: 'MemoryMailState',
  create: () => {
    clock = 1_000_000;
    return new MemoryMailState(() => clock);
  },
  advance: async (ms) => {
    clock += ms;
  },
});

describe('MemoryMailState pacing', () => {
  it('refills at 20 a minute: one slot every 3 s', async () => {
    let now = 0;
    const state = new MemoryMailState(() => now);
    for (let i = 0; i < 5; i += 1) expect(await state.takeSlot('m@example.test')).toBe(0);
    expect(await state.takeSlot('m@example.test')).toBe(3_000);

    now += 3_000;
    expect(await state.takeSlot('m@example.test')).toBe(0);
    expect(await state.takeSlot('m@example.test')).toBeGreaterThan(0);
  });

  it('never lets more than burst + rate through in any minute (stays under 30)', async () => {
    let now = 0;
    const state = new MemoryMailState(() => now);
    let granted = 0;
    // Hammer it every 100 ms for a simulated minute.
    for (; now < 60_000; now += 100)
      if ((await state.takeSlot('m@example.test')) === 0) granted += 1;
    expect(granted).toBeLessThanOrEqual(25);
    expect(granted).toBeGreaterThanOrEqual(24);
  });
});

describe('MemoryEmailSender refuses production (M-C)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('throws when constructed under NODE_ENV=production, naming the cause', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => new MemoryEmailSender()).toThrow(
      /must not be used when NODE_ENV=production.*sends nothing/s,
    );
  });

  it.each(['development', 'test', ''])('builds under NODE_ENV=%o', (env) => {
    vi.stubEnv('NODE_ENV', env);
    expect(() => new MemoryEmailSender()).not.toThrow();
  });
});

describe('MemoryEmailSender', () => {
  it('numbers its ids and records the validated message', async () => {
    const sender = new MemoryEmailSender();
    expect((await sender.send(sampleMessage())).id).toBe('memory-1');
    expect((await sender.send(sampleMessage())).id).toBe('memory-2');
    expect(sender.sent).toHaveLength(2);
  });

  it('injects each fault once, in order', async () => {
    const sender = new MemoryEmailSender();
    sender.failNext({ kind: 'unavailable' });
    sender.failNext({ kind: 'forbidden' });

    await expect(sender.send(sampleMessage())).rejects.toMatchObject({ code: 'unavailable' });
    await expect(sender.send(sampleMessage())).rejects.toMatchObject({ code: 'forbidden' });
    await expect(sender.send(sampleMessage())).resolves.toBeDefined();
    expect(sender.sent).toHaveLength(1);
  });

  it('does not deduplicate: a transport has no memory', async () => {
    const sender = new MemoryEmailSender();
    const message = sampleMessage({ idempotencyKey: 'same' });
    await sender.send(message);
    await sender.send(message);
    expect(sender.sent).toHaveLength(2);
  });
});

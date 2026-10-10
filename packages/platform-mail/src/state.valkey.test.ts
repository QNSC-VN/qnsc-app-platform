import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dockerTestsEnabled, startValkey, type ValkeyHarness } from '@quynhonsemiconductor/testing';
import { GraphServer, graphError } from './__helpers__/graph-server';
import { createGraphSender } from './graph';
import { createMailHandler } from './jobs';
import { createValkeyMailState, ledgerKey, type MailState, type ValkeyLike } from './state';
import { MemoryEmailSender, describeMailStateConformance, sampleMessage } from './testing';

// Real Valkey (packages/testing): the claim, the release and the token bucket are Lua scripts,
// so what is under test is the server's behaviour, not a double's. Skipped without Docker
// locally; on CI a missing Docker fails the run.
const dockerEnabled = await dockerTestsEnabled();

describe.skipIf(!dockerEnabled)('createValkeyMailState (real Valkey)', () => {
  let valkey: ValkeyHarness;
  const clients: Redis[] = [];
  const client = (keyPrefix = 'test:'): Redis => {
    const created = new Redis(valkey.url, { keyPrefix });
    clients.push(created);
    return created;
  };

  beforeAll(async () => {
    valkey = await startValkey();
  }, 120_000);
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.quit().catch(() => undefined)));
    await valkey?.stop();
  }, 60_000);
  beforeEach(async () => {
    await valkey.flush();
  });

  // An ioredis client satisfies ValkeyLike as is (this line is the type-level proof).
  const asLike: ValkeyLike = new Redis({ lazyConnect: true });
  void asLike;

  describeMailStateConformance({
    name: 'createValkeyMailState (real Valkey)',
    create: async () => {
      await valkey.flush();
      return createValkeyMailState(client());
    },
  });

  it('applies the client key prefix to every key it writes', async () => {
    const state = createValkeyMailState(client('mail-test:'));
    await state.claim(ledgerKey('m@example.test', 'k'), 30);
    await state.takeSlot('m@example.test');
    await state.backOff('m@example.test', 30);

    const keys = await client('').keys('*');
    expect(keys.sort()).toEqual(
      [
        `mail-test:${ledgerKey('m@example.test', 'k')}`,
        'mail-test:mail:rate:m@example.test',
        'mail-test:mail:cooldown:m@example.test',
      ].sort(),
    );
  });

  it('expires the ledger entry after its ttl', async () => {
    const state = createValkeyMailState(client());
    await state.claim('k', 30);
    await state.markSent('k', 'msg', 1);
    expect((await state.claim('k', 30)).status).toBe('sent');

    await new Promise((r) => setTimeout(r, 1_300));
    expect((await state.claim('k', 30)).status).toBe('claimed');
  }, 10_000);

  it('shares the bucket between two clients (two replicas): 5 burst in total, not 5 each', async () => {
    const a = createValkeyMailState(client());
    const b = createValkeyMailState(client());
    const granted: number[] = [];
    for (let i = 0; i < 10; i += 1)
      granted.push(await (i % 2 === 0 ? a : b).takeSlot('shared@example.test'));

    expect(granted.filter((w) => w === 0)).toHaveLength(5);
  });

  it('refills the bucket on the server clock: a wait of about 3 s is real time away', async () => {
    const state = createValkeyMailState(client());
    for (let i = 0; i < 5; i += 1) await state.takeSlot('slow@example.test');
    const wait = await state.takeSlot('slow@example.test');
    expect(wait).toBeGreaterThan(2_500);

    await new Promise((r) => setTimeout(r, wait + 100));
    expect(await state.takeSlot('slow@example.test')).toBe(0);
  }, 10_000);

  it('makes every replica wait out a cooldown one of them started, on the server clock', async () => {
    const a = createValkeyMailState(client());
    const b = createValkeyMailState(client());
    await a.backOff('cool@example.test', 2);

    expect(await b.takeSlot('cool@example.test')).toBeGreaterThan(1_000);
    expect(await a.takeSlot('cool@example.test')).toBeGreaterThan(1_000);
    await new Promise((r) => setTimeout(r, 2_200));
    expect(await b.takeSlot('cool@example.test')).toBe(0);
  }, 10_000);

  it('does not let a shorter back-off shorten the cooldown, nor a cooldown consume bucket tokens', async () => {
    const state = createValkeyMailState(client());
    await state.backOff('cool2@example.test', 30);
    await state.backOff('cool2@example.test', 1);
    for (let i = 0; i < 20; i += 1) await state.takeSlot('cool2@example.test');

    expect(await state.takeSlot('cool2@example.test')).toBeGreaterThan(20_000);
    const keys = await client('').keys('test:mail:rate:cool2*');
    expect(keys).toEqual([]); // the bucket was never touched while cooling down
  });

  it('worker A waits out a 429 Retry-After: 20 inside send() and worker B, on another client, is held back', async () => {
    const graph = new GraphServer();
    await graph.start();
    try {
      graph.reply({
        status: 429,
        headers: { 'retry-after': '20' },
        body: graphError('ApplicationThrottled'),
      });
      let wake!: () => void;
      let sleeping!: () => void;
      const asleep = new Promise<void>((resolve) => (sleeping = resolve));
      const handlerA = createMailHandler({
        sender: createGraphSender({
          sender: 'noreply-academy@qnsc.vn',
          credential: { getToken: async () => ({ token: 't' }) },
          baseUrl: graph.baseUrl,
          random: () => 1,
          sleep: () =>
            new Promise<void>((resolve) => {
              wake = resolve;
              sleeping();
            }),
        }),
        state: createValkeyMailState(client()),
      });
      const sending = handlerA({
        id: 'a',
        data: sampleMessage({ idempotencyKey: 'in-place-429' }),
        attempt: 1,
        signal: new AbortController().signal,
      });
      await asleep;

      const stateB = createValkeyMailState(client());
      const wait = await stateB.takeSlot('noreply-academy@qnsc.vn');
      expect(wait).toBeGreaterThan(19_000);
      expect(wait).toBeLessThanOrEqual(20_000);

      wake();
      await sending;
      expect(graph.accepted).toHaveLength(1);
    } finally {
      await graph.stop();
    }
  });

  it('renews a claim on the server: it outlives its lease while renewed and lapses once renewal stops', async () => {
    const state = createValkeyMailState(client());
    const claim = await state.claim('renew-me', 1);
    if (claim.status !== 'claimed') throw new Error('expected a claim');
    for (let i = 0; i < 3; i += 1) {
      await new Promise((r) => setTimeout(r, 600));
      expect(await state.renew('renew-me', claim.token, 1)).toBe(true);
    }
    expect((await state.claim('renew-me', 30)).status).toBe('in-flight'); // 1.8 s in, lease 1 s: renewed

    await new Promise((r) => setTimeout(r, 1_300)); // renewal stopped, as if its worker had been killed
    expect((await state.claim('renew-me', 30)).status).toBe('claimed');
    expect(await state.renew('renew-me', claim.token, 1)).toBe(false); // and the old holder cannot take it back
  }, 15_000);

  describe('two workers, one message', () => {
    const worker = (state: MailState, sender: MemoryEmailSender) =>
      createMailHandler({ sender, state, sleep: async () => {} });
    const job = (data: unknown) => ({
      id: 'j',
      data: data as never,
      attempt: 1,
      signal: new AbortController().signal,
    });

    it('the same message delivered to two workers at once is sent exactly once', async () => {
      const sender = new MemoryEmailSender('noreply-academy@qnsc.vn');
      const first = worker(createValkeyMailState(client()), sender);
      const second = worker(createValkeyMailState(client()), sender);
      const message = sampleMessage({ idempotencyKey: 'both-workers' });

      await Promise.allSettled([first(job(message)), second(job(message))]);
      expect(sender.sent).toHaveLength(1);

      // And a later redelivery, to either worker, is still a no-op.
      await Promise.all([first(job(message)), second(job(message))]);
      expect(sender.sent).toHaveLength(1);
    });

    it('a failure on one worker releases the claim, so the other can send it', async () => {
      const sender = new MemoryEmailSender('noreply-academy@qnsc.vn');
      const first = worker(createValkeyMailState(client()), sender);
      const second = worker(createValkeyMailState(client()), sender);
      const message = sampleMessage({ idempotencyKey: 'handover' });

      sender.failNext({ kind: 'unavailable' });
      await expect(first(job(message))).rejects.toMatchObject({ code: 'unavailable' });
      await second(job(message));

      expect(sender.sent).toHaveLength(1);
    });
  });
});

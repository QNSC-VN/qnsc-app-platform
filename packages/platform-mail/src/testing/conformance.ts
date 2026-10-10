/**
 * Conformance suites for the two contracts of this package.
 *
 * ```ts
 * import { describeEmailSenderConformance } from '@quynhonsemiconductor/platform-mail/testing';
 *
 * describeEmailSenderConformance({
 *   name: 'MyTransport',
 *   create: () => ({ sender, delivered: async () => wireCapture.messages }),
 * });
 * ```
 *
 * `describe`/`it`/`expect` are taken from the caller's vitest globals rather than imported
 * here (enable `test.globals: true`), so the package carries no test-framework dependency.
 */
import { MailSendError } from '../errors';
import type { EmailMessage, EmailSender } from '../message';
import type { MailState } from '../state';

interface Matchers {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toBeInstanceOf(expected: unknown): void;
  toBeGreaterThan(expected: number): void;
  toBeLessThanOrEqual(expected: number): void;
  toBeTruthy(): void;
  toMatch(expected: RegExp): void;
  toHaveLength(expected: number): void;
  not: Matchers;
}

interface TestApi {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => void | Promise<void>, timeoutMs?: number) => void;
  expect: (actual: unknown) => Matchers;
  afterEach: (fn: () => void | Promise<void>) => void;
}

function testApi(): TestApi {
  const g = globalThis as unknown as Partial<TestApi>;
  if (!g.describe || !g.it || !g.expect || !g.afterEach) {
    throw new Error(
      'platform-mail conformance suites need vitest globals. Enable `test.globals: true` in the ' +
        'consuming vitest config.',
    );
  }
  return g as TestApi;
}

/** What a transport put on the wire for one message. */
export interface DeliveredMessage {
  to: readonly string[];
  cc: readonly string[];
  bcc: readonly string[];
  replyTo?: string | undefined;
  subject: string;
  html: string;
  headers: Readonly<Record<string, string>>;
}

export type Fault =
  | { kind: 'throttled'; retryAfterSeconds: number }
  | { kind: 'unavailable' }
  | { kind: 'forbidden' };

export interface EmailSenderHarness {
  sender: EmailSender;
  /** Everything the transport actually delivered since `create()`. */
  delivered(): Promise<readonly DeliveredMessage[]>;
  /** The next `send()` meets this provider response. Omit if the transport cannot simulate it. */
  failNext?: ((fault: Fault) => void) | undefined;
  cleanup?: (() => void | Promise<void>) | undefined;
}

export interface EmailSenderConformanceOptions {
  /** Shown in the describe title, e.g. the transport name. */
  name: string;
  /** A fresh harness per test. A shared one makes ordering matter. */
  create: () => Promise<EmailSenderHarness> | EmailSenderHarness;
}

export function sampleMessage(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    to: 'alice@example.test',
    subject: 'Verify your email',
    html: '<p>Open <a href="https://app.example.test/verify?t=SECRET-LINK-TOKEN">this link</a>.</p>',
    text: 'Open https://app.example.test/verify?t=SECRET-LINK-TOKEN',
    category: 'auth.verify-email',
    idempotencyKey: `conformance:${Math.random().toString(36).slice(2)}`,
    ...overrides,
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  return undefined;
}

/**
 * What every `EmailSender` must do, whatever it sends through. A transport passes when:
 *
 * - it resolves `{ id, transport }` and delivers the recipients, subject, HTML, reply-to and
 *   headers it was given;
 * - it rejects an invalid message with `MailSendError('invalid_message')` BEFORE delivering
 *   anything, and the error text never echoes the subject, the body or a recipient;
 * - it refuses a `from` that is not its own mailbox;
 * - under provider throttling it either succeeds after retrying in place (delivered exactly
 *   once) or fails with a retryable `throttled` error that carries `retryAfterSeconds` and
 *   delivered nothing — never twice;
 * - a 403 is `forbidden`, not retryable, and delivers nothing;
 * - an already-aborted signal delivers nothing.
 */
export function describeEmailSenderConformance(options: EmailSenderConformanceOptions): void {
  const { describe, it, expect, afterEach } = testApi();

  describe(`EmailSender conformance: ${options.name}`, () => {
    let harness: EmailSenderHarness | undefined;
    const make = async (): Promise<EmailSenderHarness> => {
      harness = await options.create();
      return harness;
    };
    afterEach(async () => {
      await harness?.cleanup?.();
      harness = undefined;
    });

    it('delivers a message and resolves an id and the transport name', async () => {
      const { sender, delivered } = await make();
      const result = await sender.send(sampleMessage());

      expect(typeof result.id).toBe('string');
      expect(result.id.length).toBeGreaterThan(0);
      expect(typeof result.transport).toBe('string');
      expect(await delivered()).toHaveLength(1);
    });

    it('delivers recipients, subject, html, reply-to and headers as given', async () => {
      const { sender, delivered } = await make();
      await sender.send(
        sampleMessage({
          to: ['a@example.test', 'b@example.test'],
          cc: 'c@example.test',
          bcc: ['d@example.test'],
          replyTo: 'help@example.test',
          subject: 'Hello — ünïcode ✓',
          html: '<p>héllo</p>',
          headers: { 'x-qnsc-trace': 'abc123' },
        }),
      );

      const [message] = await delivered();
      expect(message?.to).toEqual(['a@example.test', 'b@example.test']);
      expect(message?.cc).toEqual(['c@example.test']);
      expect(message?.bcc).toEqual(['d@example.test']);
      expect(message?.replyTo).toBe('help@example.test');
      expect(message?.subject).toBe('Hello — ünïcode ✓');
      expect(message?.html).toBe('<p>héllo</p>');
      expect(message?.headers['x-qnsc-trace']).toBe('abc123');
    });

    const invalidMessages: [string, Partial<EmailMessage>][] = [
      ['no recipient', { to: [] }],
      ['a recipient that is not an address', { to: 'not-an-address' }],
      ['a display-name address', { to: 'Alice <alice@example.test>' }],
      ['a CR/LF in the subject', { subject: 'hi\r\nBcc: attacker@example.test' }],
      ['a header that does not start with x-', { headers: { 'reply-to': 'x@example.test' } }],
      ['a CR/LF in a header value', { headers: { 'x-a': 'b\r\nc: d' } }],
      ['an empty subject', { subject: '   ' }],
      ['an upper-case category', { category: 'Auth.Verify' }],
      ['an empty idempotency key', { idempotencyKey: '' }],
    ];
    for (const [label, overrides] of invalidMessages) {
      it(`rejects ${label} as invalid_message and delivers nothing`, async () => {
        const { sender, delivered } = await make();
        const error = await rejection(sender.send(sampleMessage(overrides)));

        expect(error).toBeInstanceOf(MailSendError);
        expect((error as MailSendError).code).toBe('invalid_message');
        expect((error as MailSendError).retryable).toBe(false);
        expect(await delivered()).toHaveLength(0);
      });
    }

    it('never echoes the subject, the body or a recipient in an error', async () => {
      const { sender } = await make();
      const error = (await rejection(
        sender.send(
          sampleMessage({
            to: 'secret-recipient@example.test',
            subject: 'secret-subject\r\n',
            html: '<p>secret-body-SECRET-LINK-TOKEN</p>',
          }),
        ),
      )) as MailSendError;

      expect(error.message).not.toMatch(
        /secret-recipient|secret-subject|secret-body|SECRET-LINK-TOKEN/,
      );
    });

    it('refuses a from that is not its own mailbox', async () => {
      const { sender, delivered } = await make();
      if (!sender.mailbox) return; // a transport without a mailbox has nothing to protect
      const error = await rejection(
        sender.send(sampleMessage({ from: 'someone-else@example.test' })),
      );

      expect((error as MailSendError).code).toBe('invalid_message');
      expect(await delivered()).toHaveLength(0);
    });

    it('accepts a from equal to its own mailbox', async () => {
      const { sender, delivered } = await make();
      if (!sender.mailbox) return;
      await sender.send(sampleMessage({ from: sender.mailbox }));
      expect(await delivered()).toHaveLength(1);
    });

    it('delivers nothing when the signal is already aborted', async () => {
      const { sender, delivered } = await make();
      const error = await rejection(sender.send(sampleMessage(), { signal: AbortSignal.abort() }));

      expect(error).toBeInstanceOf(MailSendError);
      expect(await delivered()).toHaveLength(0);
    });

    it('is not delivered twice under throttling: success after a retry, or a retryable throttled error', async () => {
      const h = await make();
      if (!h.failNext) return;
      h.failNext({ kind: 'throttled', retryAfterSeconds: 1 });

      const outcome = await rejection(h.sender.send(sampleMessage()));
      const count = (await h.delivered()).length;
      if (outcome === undefined) {
        expect(count).toBe(1);
      } else {
        expect(outcome).toBeInstanceOf(MailSendError);
        expect((outcome as MailSendError).code).toBe('throttled');
        expect((outcome as MailSendError).retryable).toBe(true);
        expect((outcome as MailSendError).retryAfterSeconds).toBe(1);
        expect(count).toBe(0);
      }
    });

    it('reports 403 as forbidden, not retryable, and delivers nothing', async () => {
      const h = await make();
      if (!h.failNext) return;
      h.failNext({ kind: 'forbidden' });
      const error = (await rejection(h.sender.send(sampleMessage()))) as MailSendError;

      expect(error).toBeInstanceOf(MailSendError);
      expect(error.code).toBe('forbidden');
      expect(error.retryable).toBe(false);
      expect((await h.delivered()).length).toBe(0);
    });
  });
}

export interface MailStateConformanceOptions {
  name: string;
  /** A fresh, EMPTY state per test. */
  create: () => Promise<MailState> | MailState;
  /** Wait this long (real or fake time). Used to cross a one-second lease. Default: real sleep. */
  advance?: ((ms: number) => Promise<void>) | undefined;
}

/**
 * What the `mail.send` handler needs of its {@link MailState}: an atomic claim, a final
 * `sent`, a release that cannot undo it or steal another holder's claim, a lease that
 * expires, and a per-mailbox pacing bucket.
 */
export function describeMailStateConformance(options: MailStateConformanceOptions): void {
  const { describe, it, expect } = testApi();
  const advance = options.advance ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  describe(`MailState conformance: ${options.name}`, () => {
    it('grants the first claim and reports the second as in flight', async () => {
      const state = await options.create();
      expect((await state.claim('k', 30)).status).toBe('claimed');
      expect((await state.claim('k', 30)).status).toBe('in-flight');
    });

    it('grants only one of many concurrent claims', async () => {
      const state = await options.create();
      const results = await Promise.all(Array.from({ length: 20 }, () => state.claim('race', 30)));
      expect(results.filter((r) => r.status === 'claimed')).toHaveLength(1);
    });

    it('reports a delivered message as sent, with its id, to every later claim', async () => {
      const state = await options.create();
      await state.claim('k', 30);
      await state.markSent('k', 'msg-1', 60);

      expect(await state.claim('k', 30)).toEqual({ status: 'sent', id: 'msg-1' });
      expect(await state.claim('k', 30)).toEqual({ status: 'sent', id: 'msg-1' });
    });

    it('lets a released claim be taken again', async () => {
      const state = await options.create();
      const first = await state.claim('k', 30);
      if (first.status !== 'claimed') throw new Error('expected a claim');
      await state.release('k', first.token);

      expect((await state.claim('k', 30)).status).toBe('claimed');
    });

    it('ignores a release with the wrong token', async () => {
      const state = await options.create();
      await state.claim('k', 30);
      await state.release('k', 'someone-elses-token');

      expect((await state.claim('k', 30)).status).toBe('in-flight');
    });

    it('never lets a release undo sent', async () => {
      const state = await options.create();
      const claim = await state.claim('k', 30);
      if (claim.status !== 'claimed') throw new Error('expected a claim');
      await state.markSent('k', 'msg-1', 60);
      await state.release('k', claim.token);

      expect((await state.claim('k', 30)).status).toBe('sent');
    });

    it('frees a claim whose lease ran out (a crashed attempt)', async () => {
      const state = await options.create();
      await state.claim('k', 1);
      await advance(1_200);

      expect((await state.claim('k', 30)).status).toBe('claimed');
    }, 10_000);

    it('keeps keys independent', async () => {
      const state = await options.create();
      await state.claim('a', 30);
      expect((await state.claim('b', 30)).status).toBe('claimed');
    });

    it('lets a burst through, then asks for a wait of about one interval', async () => {
      const state = await options.create();
      const waits: number[] = [];
      for (let i = 0; i < 7; i += 1) waits.push(await state.takeSlot('noreply-a@example.test'));

      expect(waits.slice(0, 5)).toEqual([0, 0, 0, 0, 0]);
      // 20 a minute is one every 3000 ms.
      expect(waits[5]).toBeGreaterThan(2_000);
      expect(waits[5]).toBeLessThanOrEqual(3_000);
      expect(waits[6]).toBeGreaterThan(2_000);
    });

    it('grants no slot to anyone while the mailbox is backed off, then resumes', async () => {
      const state = await options.create();
      await state.backOff('noreply-a@example.test', 2);

      const wait = await state.takeSlot('noreply-a@example.test');
      expect(wait).toBeGreaterThan(1_000);
      expect(wait).toBeLessThanOrEqual(2_000);
      // The cooldown consumed nothing from the bucket.
      await advance(2_100);
      expect(await state.takeSlot('noreply-a@example.test')).toBe(0);
    }, 10_000);

    it('backs off one mailbox without touching another', async () => {
      const state = await options.create();
      await state.backOff('noreply-a@example.test', 30);

      expect(await state.takeSlot('noreply-b@example.test')).toBe(0);
      expect(await state.takeSlot('NOREPLY-A@example.test')).toBeGreaterThan(0);
    });

    it('never shortens a cooldown: a later, shorter back-off is ignored', async () => {
      const state = await options.create();
      await state.backOff('noreply-a@example.test', 30);
      await state.backOff('noreply-a@example.test', 1);

      expect(await state.takeSlot('noreply-a@example.test')).toBeGreaterThan(20_000);
    });

    it('paces each mailbox on its own, ignoring case', async () => {
      const state = await options.create();
      for (let i = 0; i < 5; i += 1) await state.takeSlot('noreply-a@example.test');

      expect(await state.takeSlot('noreply-b@example.test')).toBe(0);
      expect(await state.takeSlot('NOREPLY-A@example.test')).toBeGreaterThan(0);
    });
  });
}

import { MailSendError } from '../errors';
import {
  assertFromIsMailbox,
  validateMessage,
  type EmailMessage,
  type EmailSender,
  type SendOptions,
  type SendResult,
  type ValidatedMessage,
} from '../message';
import { MAIL_RATE, newClaimToken, type ClaimResult, type MailState } from '../state';

/** What a test can make the next send do. */
export type InjectedFault =
  | { kind: 'throttled'; retryAfterSeconds?: number }
  | { kind: 'unavailable' }
  | { kind: 'forbidden' };

/**
 * An `EmailSender` that keeps messages in memory instead of sending them.
 *
 * It validates exactly like the real transports (same `invalid_message` errors, same limits), so
 * a test that passes against it cannot be passing only because it skipped validation, and it
 * refuses a `from` other than its mailbox like the Graph transport does. It does not
 * deduplicate: like every transport, it has no memory — that is the queue's job.
 */
export class MemoryEmailSender implements EmailSender {
  readonly sent: ValidatedMessage[] = [];
  private readonly faults: InjectedFault[] = [];
  private counter = 0;

  constructor(readonly mailbox: string = 'noreply@example.test') {}

  /** The next `send()` fails this way (once). Queue several to fail several in a row. */
  failNext(fault: InjectedFault): void {
    this.faults.push(fault);
  }

  async send(message: EmailMessage, options: SendOptions = {}): Promise<SendResult> {
    const validated = validateMessage(message);
    assertFromIsMailbox(validated, this.mailbox);
    if (options.signal?.aborted) throw new MailSendError('timeout', 'Send aborted by the caller.');

    const fault = this.faults.shift();
    if (fault) {
      if (fault.kind === 'throttled') {
        throw new MailSendError('throttled', 'Injected throttling.', {
          status: 429,
          retryAfterSeconds: fault.retryAfterSeconds ?? 1,
        });
      }
      if (fault.kind === 'forbidden') {
        throw new MailSendError('forbidden', 'Injected 403.', { status: 403 });
      }
      throw new MailSendError('unavailable', 'Injected 503.', { status: 503 });
    }

    this.sent.push(validated);
    this.counter += 1;
    return { id: `memory-${this.counter}`, transport: 'memory' };
  }
}

/**
 * {@link MailState} in memory, with an injectable clock so a test can cross a lease or refill
 * the bucket without sleeping. One process only: it demonstrates the contract, it does not
 * coordinate workers — production uses `createValkeyMailState`.
 */
export class MemoryMailState implements MailState {
  private readonly entries = new Map<string, { value: string; expiresAt: number }>();
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly cooldowns = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  private live(key: string): string | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  async claim(key: string, leaseSeconds: number): Promise<ClaimResult> {
    const value = this.live(key);
    if (value === undefined) {
      const token = newClaimToken();
      this.entries.set(key, {
        value: `claimed:${token}`,
        expiresAt: this.now() + leaseSeconds * 1000,
      });
      return { status: 'claimed', token };
    }
    if (value.startsWith('sent:')) return { status: 'sent', id: value.slice(5) };
    return { status: 'in-flight' };
  }

  async markSent(key: string, id: string, ttlSeconds: number): Promise<void> {
    this.entries.set(key, { value: `sent:${id}`, expiresAt: this.now() + ttlSeconds * 1000 });
  }

  async release(key: string, token: string): Promise<void> {
    if (this.live(key) === `claimed:${token}`) this.entries.delete(key);
  }

  async backOff(mailbox: string, seconds: number): Promise<void> {
    const key = mailbox.toLowerCase();
    const until = this.now() + Math.ceil(seconds * 1000);
    if (until > (this.cooldowns.get(key) ?? 0)) this.cooldowns.set(key, until);
  }

  async takeSlot(mailbox: string): Promise<number> {
    const ratePerMs = MAIL_RATE.perMinute / 60_000;
    const key = mailbox.toLowerCase();
    const now = this.now();
    const cooldown = (this.cooldowns.get(key) ?? 0) - now;
    if (cooldown > 0) return cooldown;
    const bucket = this.buckets.get(key) ?? { tokens: MAIL_RATE.burst, at: now };
    const tokens = Math.min(MAIL_RATE.burst, bucket.tokens + (now - bucket.at) * ratePerMs);
    if (tokens >= 1) {
      this.buckets.set(key, { tokens: tokens - 1, at: now });
      return 0;
    }
    this.buckets.set(key, { tokens, at: now });
    return Math.ceil((1 - tokens) / ratePerMs);
  }
}

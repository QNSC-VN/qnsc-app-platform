import { createHash, randomUUID } from 'node:crypto';

/**
 * What the `mail.send` handler needs to remember between attempts, and across workers:
 *
 * 1. **Has this message been sent?** At-least-once delivery means the same job can run twice
 *    (a crash after the provider accepted, a retry after a lost acknowledgement). pg-boss
 *    deduplicates on the job id, but a completed job is deleted at once (the payload carries a
 *    bearer link), and with it that guard. So the handler keeps its own ledger.
 * 2. **Whose turn is it?** Exchange limits a mailbox, not a process; the pacing is shared.
 *
 * Both live in the product's own Valkey (the production implementation): nothing here adds a
 * table to the product's database (P6).
 */
export type ClaimResult =
  { status: 'claimed'; token: string } | { status: 'sent'; id: string } | { status: 'in-flight' };

export interface MailState {
  /**
   * Take the right to send the message with this ledger key, atomically. `sent` means an
   * earlier attempt delivered it — do not send. `in-flight` means another attempt holds the
   * claim right now. A claim not released or completed expires after `leaseSeconds`.
   */
  claim(key: string, leaseSeconds: number): Promise<ClaimResult>;
  /** Record delivery. Final: later claims for the key see `sent` until `ttlSeconds` pass. */
  markSent(key: string, id: string, ttlSeconds: number): Promise<void>;
  /** Give the claim back after a failed attempt, so the retry can take it. Never undoes `sent`. */
  release(key: string, token: string): Promise<void>;
  /**
   * Ask for one send slot on `mailbox`. Resolves to `0` when granted, otherwise the
   * milliseconds to wait before asking again (nothing was consumed). While the mailbox is in a
   * cooldown ({@link MailState.backOff}) no slot is granted, whatever the bucket holds.
   */
  takeSlot(mailbox: string): Promise<number>;
  /**
   * The provider throttled this mailbox: grant no slot to ANY worker for `seconds` (a later,
   * shorter call never shortens an existing cooldown). Without it, every other worker keeps
   * sending into a mailbox Exchange has just told us to leave alone.
   */
  backOff(mailbox: string, seconds: number): Promise<void>;
}

/**
 * Pacing per sender mailbox. Exchange Online allows about 30 messages a minute per mailbox
 * (APP-PLATFORM-PLAN §4.4); 20 leaves headroom for the mailbox's own traffic. The bucket holds
 * 5, so a short burst (several OTPs at once) goes out at once, and the most that can leave in
 * any minute is 5 + 20 = 25 — still under the limit.
 */
export const MAIL_RATE = Object.freeze({ perMinute: 20, burst: 5 });

/**
 * The ledger key for a message, SCOPED TO THE MAILBOX: the same idempotency key sent from two
 * mailboxes is two emails. Hashed so the Valkey key is short and carries no user id.
 */
export function ledgerKey(mailbox: string, idempotencyKey: string): string {
  const digest = createHash('sha256')
    .update(mailbox.toLowerCase())
    .update('\0')
    .update(idempotencyKey)
    .digest('hex');
  return `mail:sent:${digest}`;
}

export function rateKey(mailbox: string): string {
  return `mail:rate:${mailbox.toLowerCase()}`;
}

export function cooldownKey(mailbox: string): string {
  return `mail:cooldown:${mailbox.toLowerCase()}`;
}

export function newClaimToken(): string {
  return randomUUID();
}

/** The part of an ioredis client this uses: scripts only, so every step is atomic. */
export interface ValkeyLike {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

const CLAIM = `
local v = redis.call('GET', KEYS[1])
if not v then
  redis.call('SET', KEYS[1], 'claimed:' .. ARGV[1], 'EX', ARGV[2])
  return 'claimed'
end
if string.sub(v, 1, 5) == 'sent:' then return v end
return 'in-flight'
`;

const MARK_SENT = `
redis.call('SET', KEYS[1], 'sent:' .. ARGV[1], 'EX', ARGV[2])
return 1
`;

const RELEASE = `
if redis.call('GET', KEYS[1]) == 'claimed:' .. ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

// Token bucket, on the server's clock so replicas agree. Returns 0 when a token was taken,
// else the milliseconds until one is available (and takes nothing). A cooldown on the mailbox
// (KEYS[2]) is honoured first: its remaining milliseconds, and the bucket is left alone.
const TAKE_SLOT = `
local cooldown = redis.call('PTTL', KEYS[2])
if cooldown > 0 then return cooldown end
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local ratePerMs = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local state = redis.call('HMGET', KEYS[1], 'tokens', 'at')
local tokens = tonumber(state[1])
local at = tonumber(state[2])
if tokens == nil then tokens = burst; at = now end
tokens = math.min(burst, tokens + (now - at) * ratePerMs)
local wait = 0
if tokens >= 1 then tokens = tokens - 1 else wait = math.ceil((1 - tokens) / ratePerMs) end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'at', tostring(now))
redis.call('PEXPIRE', KEYS[1], 120000)
return wait
`;

// The cooldown is a key that expires: "not before" is its remaining TTL. Only ever extended.
const BACK_OFF = `
local ms = tonumber(ARGV[1])
if redis.call('PTTL', KEYS[1]) < ms then redis.call('SET', KEYS[1], '1', 'PX', ms) end
return 1
`;

/**
 * {@link MailState} on Valkey/Redis. Pass any client with `eval` — an `ioredis` instance, or
 * `CacheService.instance` from `platform-cache` (its key prefix applies to every key here).
 * Requires Valkey ≥ 7 / Redis ≥ 5 (`TIME` before a write inside a script).
 */
export function createValkeyMailState(client: ValkeyLike): MailState {
  return {
    async claim(key, leaseSeconds) {
      const token = newClaimToken();
      const reply = String(await client.eval(CLAIM, 1, key, token, leaseSeconds));
      if (reply === 'claimed') return { status: 'claimed', token };
      if (reply.startsWith('sent:')) return { status: 'sent', id: reply.slice(5) };
      return { status: 'in-flight' };
    },
    async markSent(key, id, ttlSeconds) {
      await client.eval(MARK_SENT, 1, key, id, ttlSeconds);
    },
    async release(key, token) {
      await client.eval(RELEASE, 1, key, token);
    },
    async takeSlot(mailbox) {
      const ratePerMs = MAIL_RATE.perMinute / 60_000;
      return Number(
        await client.eval(
          TAKE_SLOT,
          2,
          rateKey(mailbox),
          cooldownKey(mailbox),
          ratePerMs,
          MAIL_RATE.burst,
        ),
      );
    },
    async backOff(mailbox, seconds) {
      await client.eval(BACK_OFF, 1, cooldownKey(mailbox), Math.ceil(seconds * 1000));
    },
  };
}

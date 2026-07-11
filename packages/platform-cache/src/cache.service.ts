import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import Redis from 'ioredis';
import { CACHE_OPTIONS, type CacheMode, type CacheModuleOptions } from './cache.types';

/**
 * Shared Valkey/Redis cache primitive (ioredis wrapper).
 *
 * This is the generic *mechanism* — connection lifecycle, key/value access, a
 * token-bucket rate-limit helper, and distributed locks. It carries no domain
 * policy: auth-token denylist/rotation semantics live in `@qnsc-vn/identity`
 * (`AuthTokenCache`), and each product owns its own rate-limit/cache policy.
 *
 * Runtime state is per-product: each backend wires its own connection options
 * ({@link CacheModuleOptions}), so importing this shared code never implies a
 * shared Valkey instance.
 */
@Injectable()
export class CacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private client: Redis | null = null;
  private readonly mode: CacheMode;

  constructor(@Inject(CACHE_OPTIONS) private readonly options: CacheModuleOptions) {
    this.mode = options.mode ?? 'required';
  }

  onModuleInit(): void {
    const url = this.options.url;
    if (!url) {
      if (this.mode === 'required') {
        throw new Error('CacheService: a connection url is required in "required" mode');
      }
      this.logger.warn('Cache url not set — cache disabled (optional mode)');
      return;
    }

    // NB: lazyConnect MUST be false. With lazyConnect the client stays in the
    // `wait` state until the first command is issued, but callers short-circuit
    // on `isAvailable` (status === 'ready') and never issue a command — so the
    // connection is never established and the cache is permanently reported
    // "unavailable". Eager connect avoids this.
    this.client = new Redis(url, {
      keyPrefix: this.options.keyPrefix,
      enableReadyCheck: true,
      maxRetriesPerRequest: 3,
      lazyConnect: false,
    });

    this.client.on('error', (err) => this.logger.error({ err }, 'Cache connection error'));
    this.client.on('ready', () => this.logger.log('Cache ready'));
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit();
  }

  /** Raw ioredis client, or `null` when the cache is disabled (optional mode). */
  get redis(): Redis | null {
    return this.client;
  }

  /**
   * Raw ioredis client; throws if the cache is disabled. Use in `required`-mode
   * contexts where the connection is guaranteed to exist.
   */
  get instance(): Redis {
    if (!this.client) {
      throw new Error('CacheService: client is not available (cache disabled)');
    }
    return this.client;
  }

  /** Whether the cache connection is established and ready to serve commands. */
  get isAvailable(): boolean {
    return this.client?.status === 'ready';
  }

  // ── Generic key/value ────────────────────────────────────────────────────────

  /** Set a key with optional TTL (seconds). No-op when the cache is disabled. */
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (!this.client) return;
    if (ttlSeconds) {
      await this.client.setex(key, ttlSeconds, value);
    } else {
      await this.client.set(key, value);
    }
  }

  /** Get a key. Returns `null` if not found or the cache is disabled. */
  async get(key: string): Promise<string | null> {
    return this.client?.get(key) ?? null;
  }

  /** Set a JSON-serializable value with optional TTL (seconds). */
  async setJson<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    await this.set(key, JSON.stringify(value), ttlSeconds);
  }

  /** Get and parse a JSON value. Returns `null` if missing, disabled, or corrupt. */
  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.get(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      this.logger.warn(`Corrupt JSON in cache for key ${key} — ignoring`);
      return null;
    }
  }

  /** Delete one or more keys. No-op when the cache is disabled. */
  async del(...keys: string[]): Promise<void> {
    if (!this.client || keys.length === 0) return;
    await this.client.del(...keys);
  }

  // ── Rate-limit (atomic sliding-window log via sorted sets) ───────────────────

  /**
   * Atomic sliding-window rate limiter, evaluated server-side in a single Lua
   * call: evict entries older than the window, count what remains, then admit
   * (record the request) or reject. A true sliding window avoids the burst that
   * a fixed-window counter allows at window boundaries.
   *
   * Returns `{ allowed, remaining, resetAt }` where `resetAt` is the Unix-seconds
   * timestamp at which the window next frees a slot. Fails open (allowed) when
   * the cache is disabled so a missing cache never blocks traffic.
   *
   * This is a generic mechanism; rate-limit *policy* (tiers, limits, which routes)
   * stays in each product's guard.
   */
  async consumeRateLimit(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
    const windowMs = windowSeconds * 1000;
    const nowMs = Date.now();

    if (!this.client) {
      return { allowed: true, remaining: limit, resetAt: Math.floor(nowMs / 1000) + windowSeconds };
    }

    // Unique member so multiple requests in the same millisecond each get a slot.
    const member = `${nowMs}:${Math.random().toString(36).slice(2, 10)}`;
    const [allowed, remaining, resetAtMs] = (await this.client.eval(
      CacheService.SLIDING_WINDOW_LUA,
      1,
      `rl:${key}`,
      String(nowMs),
      String(windowMs),
      String(limit),
      member,
    )) as [number, number, number];

    return {
      allowed: Number(allowed) === 1,
      remaining: Math.max(0, Number(remaining)),
      resetAt: Math.ceil(Number(resetAtMs) / 1000),
    };
  }

  /**
   * Sliding-window admission control over a sorted set scored by request time
   * (ms). Returns `{ allowed, remaining, resetAtMs }`.
   */
  private static readonly SLIDING_WINDOW_LUA = `
local key    = KEYS[1]
local now    = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit  = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)

if count < limit then
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, window)
  return {1, limit - count - 1, now + window}
else
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  return {0, 0, tonumber(oldest[2]) + window}
end
`;

  // ── Distributed locks (Redlock-lite via SET NX PX) ───────────────────────────

  /**
   * Attempt to acquire a distributed lock.
   * Returns true if the lock was acquired, false if already held (or the cache is
   * disabled). The lock auto-expires after ttlMs to prevent deadlocks on pod crash.
   */
  async acquireLock(key: string, ttlMs: number): Promise<boolean> {
    if (!this.client) return false;
    const result = await this.client.set(`lock:${key}`, '1', 'PX', ttlMs, 'NX');
    return result === 'OK';
  }

  /**
   * Release a distributed lock.
   * Safe to call even if the lock has already expired or the cache is disabled.
   */
  async releaseLock(key: string): Promise<void> {
    if (!this.client) return;
    await this.client.del(`lock:${key}`);
  }
}

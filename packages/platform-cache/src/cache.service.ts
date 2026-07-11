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

  // ── Rate-limit token bucket (generic mechanism) ──────────────────────────────

  /**
   * Check + consume one token from a fixed-window bucket.
   * Returns `{ allowed, remaining, resetAt }`. Fails open (allowed) when the
   * cache is disabled so a missing cache never blocks traffic.
   *
   * This is a generic mechanism; rate-limit *policy* (tiers, limits, which routes)
   * stays in each product's guard.
   */
  async consumeRateLimit(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
    const now = Math.floor(Date.now() / 1000);
    const resetAt = (Math.floor(now / windowSeconds) + 1) * windowSeconds;

    if (!this.client) {
      return { allowed: true, remaining: limit, resetAt };
    }

    const windowKey = `rl:${key}:${Math.floor(now / windowSeconds)}`;
    const current = await this.client
      .multi()
      .incr(windowKey)
      .expire(windowKey, windowSeconds)
      .exec();

    const count = (current?.[0]?.[1] as number) ?? 1;
    const allowed = count <= limit;
    const remaining = Math.max(0, limit - count);

    return { allowed, remaining, resetAt };
  }

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

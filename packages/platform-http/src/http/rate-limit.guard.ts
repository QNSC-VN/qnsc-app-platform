import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CacheService } from '@quynhonsemiconductor/platform-cache';
import { SecurityMetrics, failOpenLog } from '@quynhonsemiconductor/observability';
import { RateLimitedException } from '../errors';
import {
  DISABLE_RATE_LIMIT_ENV,
  RATE_LIMIT_MODE_ENV,
  assertCacheInProduction,
  disableAliasStatus,
  readRateLimitMode,
  type RateLimitMode,
} from './cache-requirement';
import { clientIp } from './client-ip';
import {
  RATE_LIMIT_METADATA_KEY,
  RATE_LIMIT_TIERS,
  SKIP_RATE_LIMIT_KEY,
  type RateLimitTier,
} from './rate-limit.constants';

/**
 * Global rate-limit guard backed by Valkey (Redis-compatible) fixed window.
 *
 * Intended to be registered as an `APP_GUARD` so it applies to every route.
 * Behaviour can be overridden per-route:
 *   `@RateLimit('AUTH_LOGIN')` — tighter tier
 *   `@SkipRateLimit()`         — bypass entirely (health probes, etc.)
 *
 * Key strategy
 * ────────────
 * Pre-auth (login, public routes): keyed by client IP — {@link clientIp}, i.e.
 * `cf-connecting-ip`, then the first `x-forwarded-for`, then the socket address. Behind
 * Cloudflare Tunnel `req.ip` is the tunnel's address, which would put every user in one
 * bucket.
 *   `key = "{tier}:ip:{clientIp(req)}"`
 *
 * Post-auth (protected routes where the JWT guard populated `req.user`): keyed
 * by authenticated user ID — fairer for enterprise users behind NAT or shared
 * corporate egress IPs.
 *   `key = "{tier}:uid:{userId}"`
 *
 * Refresh (`AUTH_REFRESH`, `keyBy: 'refreshToken'`): keyed by SHA-256 of the
 * HttpOnly refresh-token cookie — per-session, NAT-safe without a decoded JWT.
 *   `key = "{tier}:session:{sha256(cookie).slice(0,32)}"`
 *
 * Response headers (RFC 6585 / IETF draft-ietf-httpapi-ratelimit-headers):
 *   `RateLimit-Limit`     — the window ceiling
 *   `RateLimit-Remaining` — requests left in the current window
 *   `RateLimit-Reset`     — Unix timestamp when the window resets
 *   `Retry-After`         — seconds to wait (only on 429)
 *
 * Cache requirement
 * ─────────────────
 * With `NODE_ENV=production` the application FAILS AT STARTUP if `CacheModule` has no
 * connection (optional mode, no url): a guard that quietly allows everything is the same
 * as no guard. `RATE_LIMIT_MODE=edge-only` declares that limits are enforced at the edge
 * (Cloudflare rules) only; the guard then allows every request without touching the cache.
 *
 * `RATE_LIMIT_MODE=disabled` (dev / CI) switches the guard off; `DISABLE_RATE_LIMIT=true`
 * is a deprecated alias for it. In production that is a security control turned off, so it
 * is reported like any other fail-open: a warning at bootstrap tagged
 * `securityFailOpen=rate_limit`, and `SecurityMetrics.recordFailOpen('rate_limit')` at
 * bootstrap and on every request it lets through.
 *
 * A cache that exists but is unreachable at request time still fails open, and reports it
 * the same two ways (the log field and the metric) so the alert fires.
 */
@Injectable()
export class RateLimitGuard implements CanActivate, OnApplicationBootstrap {
  private readonly logger = new Logger(RateLimitGuard.name);
  private readonly securityMetrics = new SecurityMetrics();
  /** Read once, at construction, so a typo in the setting fails at startup too. */
  private readonly mode: RateLimitMode = readRateLimitMode();
  private readonly production = process.env['NODE_ENV'] === 'production';

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(CacheService) private readonly cache: CacheService,
  ) {}

  onApplicationBootstrap(): void {
    const alias = disableAliasStatus();
    if (alias === 'honoured') {
      this.logger.warn(
        `${DISABLE_RATE_LIMIT_ENV} is deprecated; use ${RATE_LIMIT_MODE_ENV}=disabled`,
      );
    } else if (alias === 'ignored') {
      // The operator may believe the limiter is off. It is not: RATE_LIMIT_MODE wins.
      this.logger.warn(
        `${DISABLE_RATE_LIMIT_ENV}=true is IGNORED because ${RATE_LIMIT_MODE_ENV}=${this.mode} is set ` +
          `(rate limiting is ${this.mode === 'disabled' ? 'disabled' : 'not disabled by it'}); ` +
          `${DISABLE_RATE_LIMIT_ENV} is deprecated, remove it`,
      );
    }
    if (this.mode === 'disabled') {
      if (this.production) {
        // A control that is OFF in production is a fail-open like any other: say so in
        // the form the alert on `securityFailOpen` matches.
        this.logger.warn(
          failOpenLog('rate_limit', { mode: 'disabled' }),
          `${RATE_LIMIT_MODE_ENV}=disabled in production: the application does not rate limit`,
        );
        this.recordFailOpen();
      }
      return;
    }
    if (this.mode === 'edge-only') {
      this.logger.warn(`${RATE_LIMIT_MODE_ENV}=edge-only: the application does not rate limit`);
      return;
    }
    assertCacheInProduction(this.cache, 'RateLimitGuard', `${RATE_LIMIT_MODE_ENV}=edge-only`);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // ── Disabled: dev / CI bypass (RATE_LIMIT_MODE=disabled) ────────────────
    if (this.mode === 'disabled') {
      // Counted per request in production so the alert keeps firing while it stays off,
      // instead of clearing minutes after the single bootstrap data point.
      if (this.production) this.recordFailOpen();
      return true;
    }
    // ── Edge-only: limits live in Cloudflare, not here ──────────────────────
    if (this.mode === 'edge-only') return true;

    // ── @SkipRateLimit() check ──────────────────────────────────────────────
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return true;

    // ── Resolve tier (decorator > default) ──────────────────────────────────
    const tier =
      this.reflector.getAllAndOverride<RateLimitTier>(RATE_LIMIT_METADATA_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'DEFAULT';

    const tierConfig = RATE_LIMIT_TIERS[tier] as (typeof RATE_LIMIT_TIERS)[typeof tier] & {
      keyBy?: 'refreshToken';
    };
    const { limit, windowSeconds } = tierConfig;

    const req = context.switchToHttp().getRequest<
      FastifyRequest & {
        user?: { sub?: string };
        cookies?: Record<string, string | undefined>;
      }
    >();
    const reply = context.switchToHttp().getResponse<FastifyReply>();

    // ── Build tracking key ──────────────────────────────────────────────────
    const ip = clientIp(req);
    let identifier: string;
    if (tierConfig.keyBy === 'refreshToken') {
      // Per-session bucket: hash the HttpOnly cookie so raw tokens never appear
      // in Redis keys. Falls back to IP when no cookie is present.
      const rawCookie = req.cookies?.['refresh_token'];
      identifier = rawCookie
        ? `session:${createHash('sha256').update(rawCookie).digest('hex').slice(0, 32)}`
        : `ip:${ip}`;
    } else {
      // Prefer authenticated user ID so corporate NAT users aren't penalised for
      // each other. Fall back to IP for unauthenticated endpoints.
      identifier = req.user?.sub ? `uid:${req.user.sub}` : `ip:${ip}`;
    }
    const key = `${tier}:${identifier}`;

    // ── Consume one token from the bucket ───────────────────────────────────
    let allowed: boolean;
    let remaining: number;
    let resetAt: number;

    try {
      ({ allowed, remaining, resetAt } = await this.cache.consumeRateLimit(
        key,
        limit,
        windowSeconds,
      ));
    } catch (err) {
      // Rate limiting is a protective control, not a hard dependency for serving
      // traffic. If Valkey is unavailable, fail open and surface the outage in logs.
      this.logger.error(
        failOpenLog('rate_limit', { err, key, tier, ip, userId: req.user?.sub }),
        'Rate limit backend unavailable; allowing request',
      );
      this.recordFailOpen();
      return true;
    }

    // Always set informational headers (clients can surface the remaining budget).
    const setHeader = (name: string, value: string | number): void =>
      void reply.header(name, String(value));

    setHeader('RateLimit-Limit', limit);
    setHeader('RateLimit-Remaining', remaining);
    setHeader('RateLimit-Reset', resetAt);

    if (!allowed) {
      const retryAfter = Math.max(resetAt - Math.floor(Date.now() / 1000), 1);
      setHeader('Retry-After', retryAfter);

      this.logger.warn({ key, tier, ip, userId: req.user?.sub }, 'Rate limit exceeded');

      throw new RateLimitedException(`Rate limit exceeded (${tier}). Retry after ${retryAfter}s.`);
    }

    return true;
  }

  /** Never throws: telemetry must not be able to fail a request. */
  private recordFailOpen(): void {
    try {
      this.securityMetrics.recordFailOpen('rate_limit');
    } catch {
      // Dropping one data point is the correct failure here.
    }
  }
}

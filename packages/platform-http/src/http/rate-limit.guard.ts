import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ValkeyService } from '@qnsc-vn/platform-cache';
import { RateLimitedException } from '../errors';
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
 * Pre-auth (login, public routes): keyed by client IP.
 *   `key = "{tier}:ip:{req.ip}"`
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
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);
  /** Skip all rate-limiting when `DISABLE_RATE_LIMIT=true` (dev / CI only). */
  private readonly disabled = process.env['DISABLE_RATE_LIMIT'] === 'true';

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ValkeyService) private readonly valkey: ValkeyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // ── Dev bypass: DISABLE_RATE_LIMIT=true ─────────────────────────────────
    if (this.disabled) return true;

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
    let identifier: string;
    if (tierConfig.keyBy === 'refreshToken') {
      // Per-session bucket: hash the HttpOnly cookie so raw tokens never appear
      // in Redis keys. Falls back to IP when no cookie is present.
      const rawCookie = req.cookies?.['refresh_token'];
      identifier = rawCookie
        ? `session:${createHash('sha256').update(rawCookie).digest('hex').slice(0, 32)}`
        : `ip:${req.ip}`;
    } else {
      // Prefer authenticated user ID so corporate NAT users aren't penalised for
      // each other. Fall back to IP for unauthenticated endpoints.
      identifier = req.user?.sub ? `uid:${req.user.sub}` : `ip:${req.ip}`;
    }
    const key = `${tier}:${identifier}`;

    // ── Consume one token from the bucket ───────────────────────────────────
    let allowed: boolean;
    let remaining: number;
    let resetAt: number;

    try {
      ({ allowed, remaining, resetAt } = await this.valkey.consumeRateLimit(
        key,
        limit,
        windowSeconds,
      ));
    } catch (err) {
      // Rate limiting is a protective control, not a hard dependency for serving
      // traffic. If Valkey is unavailable, fail open and surface the outage in logs.
      this.logger.error(
        { err, key, tier, ip: req.ip, userId: req.user?.sub },
        'Rate limit backend unavailable; allowing request',
      );
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

      this.logger.warn({ key, tier, ip: req.ip, userId: req.user?.sub }, 'Rate limit exceeded');

      throw new RateLimitedException(`Rate limit exceeded (${tier}). Retry after ${retryAfter}s.`);
    }

    return true;
  }
}

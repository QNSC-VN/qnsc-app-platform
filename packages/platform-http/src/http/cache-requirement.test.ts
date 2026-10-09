import { describe, expect, it } from 'vitest';
import {
  assertCacheInProduction,
  disableAliasStatus,
  readIdempotencyMode,
  readRateLimitMode,
  usesDeprecatedDisableAlias,
} from './cache-requirement';

describe('readRateLimitMode', () => {
  it('defaults to cache', () => {
    expect(readRateLimitMode({})).toBe('cache');
    expect(readRateLimitMode({ RATE_LIMIT_MODE: '' })).toBe('cache');
  });

  it('accepts edge-only', () => {
    expect(readRateLimitMode({ RATE_LIMIT_MODE: 'edge-only' })).toBe('edge-only');
  });

  it('accepts disabled', () => {
    expect(readRateLimitMode({ RATE_LIMIT_MODE: 'disabled' })).toBe('disabled');
  });

  describe('deprecated DISABLE_RATE_LIMIT alias', () => {
    it('DISABLE_RATE_LIMIT=true means disabled when RATE_LIMIT_MODE is unset or blank', () => {
      expect(readRateLimitMode({ DISABLE_RATE_LIMIT: 'true' })).toBe('disabled');
      expect(readRateLimitMode({ DISABLE_RATE_LIMIT: 'true', RATE_LIMIT_MODE: ' ' })).toBe(
        'disabled',
      );
      expect(usesDeprecatedDisableAlias({ DISABLE_RATE_LIMIT: 'true' })).toBe(true);
    });

    it('an explicit RATE_LIMIT_MODE wins over the alias', () => {
      expect(readRateLimitMode({ DISABLE_RATE_LIMIT: 'true', RATE_LIMIT_MODE: 'cache' })).toBe(
        'cache',
      );
      expect(readRateLimitMode({ DISABLE_RATE_LIMIT: 'true', RATE_LIMIT_MODE: 'edge-only' })).toBe(
        'edge-only',
      );
    });

    it('only the literal "true" counts, as before', () => {
      expect(readRateLimitMode({ DISABLE_RATE_LIMIT: 'false' })).toBe('cache');
      expect(readRateLimitMode({ DISABLE_RATE_LIMIT: '1' })).toBe('cache');
      expect(usesDeprecatedDisableAlias({ DISABLE_RATE_LIMIT: '' })).toBe(false);
    });
  });

  // `edge_only` quietly meaning "cache" would crash a deploy for the wrong reason.
  it('rejects anything else, naming the setting and the allowed values', () => {
    expect(() => readRateLimitMode({ RATE_LIMIT_MODE: 'edge_only' })).toThrow(
      /RATE_LIMIT_MODE="edge_only".*cache, edge-only, disabled/,
    );
  });
});

describe('disableAliasStatus', () => {
  it.each([
    ['not set', {}, 'unset'],
    ['not "true"', { DISABLE_RATE_LIMIT: 'false' }, 'unset'],
    ['the only setting', { DISABLE_RATE_LIMIT: 'true' }, 'honoured'],
    [
      'next to a blank RATE_LIMIT_MODE',
      { DISABLE_RATE_LIMIT: 'true', RATE_LIMIT_MODE: ' ' },
      'honoured',
    ],
    [
      'overridden by RATE_LIMIT_MODE=cache',
      { DISABLE_RATE_LIMIT: 'true', RATE_LIMIT_MODE: 'cache' },
      'ignored',
    ],
    [
      'overridden by RATE_LIMIT_MODE=edge-only',
      { DISABLE_RATE_LIMIT: 'true', RATE_LIMIT_MODE: 'edge-only' },
      'ignored',
    ],
  ] as const)('is %s → %s', (_label, env, expected) => {
    expect(disableAliasStatus(env)).toBe(expected);
  });

  it('agrees with readRateLimitMode: honoured ⇒ disabled, ignored ⇒ not disabled by it', () => {
    expect(readRateLimitMode({ DISABLE_RATE_LIMIT: 'true' })).toBe('disabled');
    expect(readRateLimitMode({ DISABLE_RATE_LIMIT: 'true', RATE_LIMIT_MODE: 'cache' })).toBe(
      'cache',
    );
  });
});

describe('readIdempotencyMode', () => {
  it('defaults to cache and accepts disabled', () => {
    expect(readIdempotencyMode({})).toBe('cache');
    expect(readIdempotencyMode({ IDEMPOTENCY_MODE: 'disabled' })).toBe('disabled');
  });

  it('rejects anything else', () => {
    expect(() => readIdempotencyMode({ IDEMPOTENCY_MODE: 'off' })).toThrow(/IDEMPOTENCY_MODE/);
  });
});

describe('assertCacheInProduction', () => {
  const noCache = { redis: null };
  const withCache = { redis: {} as never };

  it('throws in production without a cache, naming the feature and the opt-out', () => {
    expect(() =>
      assertCacheInProduction(noCache, 'RateLimitGuard', 'RATE_LIMIT_MODE=edge-only', {
        NODE_ENV: 'production',
      }),
    ).toThrow(/RateLimitGuard needs a cache.*RATE_LIMIT_MODE=edge-only/s);
  });

  it('passes in production with a cache', () => {
    expect(() =>
      assertCacheInProduction(withCache, 'x', 'y', { NODE_ENV: 'production' }),
    ).not.toThrow();
  });

  it.each(['development', 'test', undefined])('passes without a cache when NODE_ENV=%s', (env) => {
    expect(() => assertCacheInProduction(noCache, 'x', 'y', { NODE_ENV: env })).not.toThrow();
  });
});

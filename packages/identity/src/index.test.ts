import 'reflect-metadata';
import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AuthContextSetter } from './auth-context';
import { JwtAuthGuard } from './jwt.guard';
import type { JwtPayload } from './jwt-payload';
import { JwtStrategy } from './jwt.strategy';

/**
 * Guard + strategy behaviour. The permission-guard and wildcard-matching cases
 * that used to live here went with the code: authorization is product-owned, so
 * `permission.guard.ts` and `permissions.ts` were removed rather than kept as a
 * shared surface neither product used.
 */

describe('JwtStrategy', () => {
  it('passes the verified payload through to request.user', () => {
    const strategy = new JwtStrategy({ publicKey: 'pem', issuer: 'iss', audience: 'aud' });
    const payload = { sub: 'u1', permissions: [] } as unknown as JwtPayload;
    expect(strategy.validate(payload)).toBe(payload);
  });
});

describe('JwtAuthGuard.handleRequest', () => {
  const valkey = {} as never;

  function makeGuard(): { guard: JwtAuthGuard; setAuthContext: ReturnType<typeof vi.fn> } {
    const setAuthContext = vi.fn();
    const ctx: AuthContextSetter = { setAuthContext };
    return { guard: new JwtAuthGuard(ctx, valkey), setAuthContext };
  }

  it('returns the user and populates auth context', () => {
    const { guard, setAuthContext } = makeGuard();
    const user = { sub: 'u1', contextId: 'w1', sessionId: 's1' };
    expect(guard.handleRequest(null, user)).toBe(user);
    expect(setAuthContext).toHaveBeenCalledWith('w1', 'u1', 's1');
  });

  it('throws when no user resolved', () => {
    const { guard } = makeGuard();
    expect(() => guard.handleRequest(null, false)).toThrow(UnauthorizedException);
  });

  it('normalizes an unexpected error to 401', () => {
    const { guard } = makeGuard();
    expect(() => guard.handleRequest(new Error('db down'), false)).toThrow(UnauthorizedException);
  });
});

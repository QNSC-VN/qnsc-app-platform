import 'reflect-metadata';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import type { AuthContextSetter } from './auth-context';
import { JwtAuthGuard } from './jwt.guard';
import type { JwtPayload } from './jwt-payload';
import { JwtStrategy } from './jwt.strategy';
import { PermissionGuard } from './permission.guard';
import { permissionGrants, WORKSPACE_ALL } from './permissions';

describe('permissionGrants', () => {
  it('denies when the user has no permissions', () => {
    expect(permissionGrants(undefined, 'project:update')).toBe(false);
    expect(permissionGrants([], 'project:update')).toBe(false);
  });

  it('allows an exact match', () => {
    expect(permissionGrants(['project:update'], 'project:update')).toBe(true);
  });

  it('allows the global workspace wildcard', () => {
    expect(permissionGrants([WORKSPACE_ALL], 'anything:goes')).toBe(true);
  });

  it('allows a namespace wildcard', () => {
    expect(permissionGrants(['project:*'], 'project:delete')).toBe(true);
    expect(permissionGrants(['project:*'], 'workitem:delete')).toBe(false);
  });
});

describe('PermissionGuard', () => {
  function contextWith(user: Partial<JwtPayload> | undefined): ExecutionContext {
    return {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    } as unknown as ExecutionContext;
  }

  function guardRequiring(required: string | undefined): PermissionGuard {
    const reflector = { getAllAndOverride: () => required } as unknown as Reflector;
    return new PermissionGuard(reflector);
  }

  it('allows routes with no required permission', () => {
    expect(guardRequiring(undefined).canActivate(contextWith(undefined))).toBe(true);
  });

  it('allows a caller holding the permission', () => {
    const guard = guardRequiring('project:update');
    const ctx = contextWith({ sub: 'u1', claims: { permissions: ['project:update'] } });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('forbids a caller missing the permission', () => {
    const guard = guardRequiring('project:update');
    const ctx = contextWith({ sub: 'u1', claims: { permissions: ['workitem:read'] } });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('honors an injected custom checker', () => {
    const reflector = { getAllAndOverride: () => 'x:y' } as unknown as Reflector;
    const guard = new PermissionGuard(reflector, () => true);
    expect(
      guard.canActivate(contextWith({ sub: 'u1', claims: { permissions: ['unrelated'] } })),
    ).toBe(true);
  });
});

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

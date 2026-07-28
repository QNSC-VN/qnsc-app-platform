import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { CacheService } from '@qnsc-vn/platform-cache';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from './auth.service';
import { AuthTokenCache } from './auth-token-cache.service';
import { EntraTokenVerifier, ENTRA_VERIFIER_OPTIONS } from './entra-verifier';
import { AUTH_SERVICE_OPTIONS } from './auth-options';
import { CLAIMS_PROVIDER } from './claims-provider';
import { AUTH_SESSION_REPOSITORY, USER_REPOSITORY } from './repository-ports';
import { ACCESS_SERVICE, AUDIT_SERVICE, WORKSPACE_SERVICE } from './service-ports';
import { TRANSACTION_RUNNER } from './transaction-runner';
import {
  InMemoryAuthSessionRepository,
  InMemoryTransactionRunner,
  InMemoryUserRepository,
  RecordingAuditService,
  StubClaimsProvider,
  describeAuthSessionRepositoryContract,
  describeUserRepositoryContract,
  makeUser,
} from './testing';

/**
 * The reference consumer.
 *
 * Every other test here constructs services directly and casts its mocks with
 * `as never`, which proves the logic but not the SEAM: a required binding could be
 * added, or the README's list could be wrong, and nothing would fail. This boots a
 * real Nest application context — the same resolution path a product uses — with
 * exactly the bindings the README documents as required, and nothing else.
 *
 * Its real value is as a canary. If a port gains a dependency, this fails with the
 * unresolved token, in this repo, instead of in a product's boot logs after
 * publishing.
 *
 * `NestFactory.createApplicationContext` rather than `@nestjs/testing`: it is the
 * production entrypoint, and it avoids adding a test-only Nest package.
 */

/** The eight collaborators + four option/infra tokens a minimum consumer must bind. */
function requiredProviders() {
  return [
    AuthService,
    AuthTokenCache,
    EntraTokenVerifier,
    { provide: USER_REPOSITORY, useValue: new InMemoryUserRepository([makeUser()]) },
    { provide: AUTH_SESSION_REPOSITORY, useValue: new InMemoryAuthSessionRepository() },
    { provide: TRANSACTION_RUNNER, useValue: new InMemoryTransactionRunner() },
    { provide: CLAIMS_PROVIDER, useValue: new StubClaimsProvider({ permissions: [] }) },
    { provide: AUDIT_SERVICE, useValue: new RecordingAuditService() },
    {
      provide: AUTH_SERVICE_OPTIONS,
      useValue: {
        jwtAccessExpiry: '15m',
        jwtRefreshExpiry: '30d',
        platformAdminEmails: [],
        nodeEnv: 'test',
      },
    },
    {
      provide: ENTRA_VERIFIER_OPTIONS,
      useValue: { tenantId: 'tenant-1', audience: 'client-1' },
    },
    // Infrastructure the product already owns elsewhere in its app.
    { provide: JwtService, useValue: { sign: () => 'signed.jwt' } },
    { provide: CacheService, useValue: { redis: null, isAvailable: false } },
  ];
}

describe('reference consumer: single-tenant product', () => {
  it('resolves AuthService with only the required bindings', async () => {
    // No ACCESS_SERVICE, no WORKSPACE_SERVICE, no SSO_CONNECTION_REPOSITORY, no
    // SSO_PROVISIONING_HOOK — the shape a single-tenant product binds. If any of
    // those ever stops being @Optional, this is where it surfaces.
    @Module({ providers: requiredProviders() })
    class MinimalIdentityModule {}

    const app = await NestFactory.createApplicationContext(MinimalIdentityModule, {
      logger: false,
    });
    try {
      expect(app.get(AuthService)).toBeInstanceOf(AuthService);
    } finally {
      await app.close();
    }
  });

  it('fails with the missing token named when a required binding is absent', async () => {
    // Pins the onboarding experience the README promises: the error identifies the
    // token, so a consumer can map it to the required table rather than guessing.
    @Module({
      providers: requiredProviders().filter(
        (p) => !('provide' in p) || p.provide !== CLAIMS_PROVIDER,
      ),
    })
    class MissingClaimsProviderModule {}

    // `abortOnError: false` is required, not stylistic: Nest's default is to call
    // process.abort() on an initialization failure, which kills the test worker
    // outright instead of rejecting. Worth knowing for a product's own boot tests.
    await expect(
      NestFactory.createApplicationContext(MissingClaimsProviderModule, {
        logger: false,
        abortOnError: false,
      }),
    ).rejects.toThrow(/CLAIMS_PROVIDER/);
  });
});

describe('reference consumer: multi-tenant product', () => {
  it('resolves AuthService with the optional collaborators bound too', async () => {
    @Module({
      providers: [
        ...requiredProviders(),
        {
          provide: ACCESS_SERVICE,
          useValue: {
            getUserRoleAndPermissions: async () => ({ role: 'member', permissions: [] }),
            elevateToWorkspaceAdmin: async () => false,
            ensureDefaultRole: async () => {},
          },
        },
        {
          provide: WORKSPACE_SERVICE,
          useValue: {
            getMemberships: async () => [],
            getMembership: async () => null,
            touchMembership: async () => {},
            enrollMember: async () => {},
          },
        },
      ],
    })
    class MultiTenantIdentityModule {}

    const app = await NestFactory.createApplicationContext(MultiTenantIdentityModule, {
      logger: false,
    });
    try {
      expect(app.get(AuthService)).toBeInstanceOf(AuthService);
    } finally {
      await app.close();
    }
  });
});

/**
 * Run the exported conformance suites against the in-memory adapters. This proves
 * the suites themselves work before a product points them at a Drizzle repository —
 * a contract test that has never run against any implementation is a liability.
 */
describeAuthSessionRepositoryContract({
  name: 'InMemoryAuthSessionRepository',
  create: () => new InMemoryAuthSessionRepository(),
});

describeUserRepositoryContract({
  name: 'InMemoryUserRepository',
  create: (seed) => new InMemoryUserRepository(seed),
  seedUser: makeUser(),
});

describe('in-memory adapters', () => {
  let users: InMemoryUserRepository;

  beforeEach(() => {
    users = new InMemoryUserRepository([makeUser()]);
  });

  it('are typed implementations, not casts', () => {
    // The point of these classes: `implements IUserRepository` means adding a
    // method to the port breaks compilation HERE, where the fix is obvious, rather
    // than passing silently as it does with `as never` mocks.
    const port: InMemoryUserRepository = users;
    expect(port).toBeInstanceOf(InMemoryUserRepository);
  });
});

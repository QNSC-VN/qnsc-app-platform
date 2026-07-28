/**
 * In-memory implementations of every port a consumer must bind.
 *
 * Their job is to be **typed**, not clever. The package's own unit tests build
 * mocks and cast them with `as never`, which means a mock missing a method — or a
 * port growing one — still compiles. These classes carry real `implements`
 * clauses, so the compiler proves the ports are implementable and breaks here the
 * moment a port changes shape.
 *
 * Two uses:
 *  - the reference-consumer test in this package boots a real Nest context on them,
 *    which is what keeps the README's "required bindings" table honest;
 *  - a product can bind them in its own tests instead of hand-rolling fakes.
 *
 * Semantics are the minimum the shared auth logic depends on — notably
 * {@link InMemoryAuthSessionRepository.revokeByIdIfActive}, whose compare-and-swap
 * return value is what makes refresh-token rotation single-use. Anything beyond
 * that (pagination, filtering, real SQL) is deliberately absent: a fake that grows
 * behaviour starts lying about the real adapter.
 */
import type { AuthContextSetter } from '../auth-context';
import type { AuthSession, CreateSessionInput, SsoIdentity, User } from '../domain-types';
import type { IAuthSessionRepository, IUserRepository } from '../repository-ports';
import type { IAuditService, AuditRecordInput } from '../service-ports';
import type { IClaimsProvider, ProductClaims } from '../claims-provider';
import type { ITransactionRunner } from '../transaction-runner';

/** Build a `User` with sane defaults; override only what a test cares about. */
export function makeUser(overrides: Partial<User> = {}): User {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: 'user-1',
    email: 'alice@example.test',
    displayName: 'Alice',
    avatarUrl: null,
    status: 'active',
    emailVerified: true,
    locale: 'en',
    timezone: 'UTC',
    phone: null,
    sessionVersion: 0,
    lastLoginAt: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export class InMemoryUserRepository implements IUserRepository {
  readonly users = new Map<string, User>();
  readonly ssoIdentities = new Map<string, SsoIdentity>();

  constructor(seed: User[] = []) {
    for (const user of seed) this.users.set(user.id, user);
  }

  private static ssoKey(provider: string, providerSub: string): string {
    return `${provider}:${providerSub}`;
  }

  async findByEmail(email: string): Promise<User | null> {
    for (const user of this.users.values()) if (user.email === email) return user;
    return null;
  }

  async findById(id: string): Promise<User | null> {
    return this.users.get(id) ?? null;
  }

  async updateLastLogin(id: string): Promise<void> {
    const user = this.users.get(id);
    if (user) this.users.set(id, { ...user, lastLoginAt: new Date() });
  }

  async updateStatus(id: string, status: string): Promise<void> {
    const user = this.users.get(id);
    if (user) this.users.set(id, { ...user, status: status as User['status'] });
  }

  async updateProfile(id: string, input: Partial<User>): Promise<User> {
    const user = this.users.get(id);
    if (!user) throw new Error(`InMemoryUserRepository: no user ${id}`);
    const updated = { ...user, ...input, updatedAt: new Date() };
    this.users.set(id, updated);
    return updated;
  }

  async findSsoIdentity(provider: string, providerSub: string): Promise<SsoIdentity | null> {
    return this.ssoIdentities.get(InMemoryUserRepository.ssoKey(provider, providerSub)) ?? null;
  }

  /**
   * Find-or-create by email, then link the SSO identity — idempotent, because a
   * user logging in twice concurrently must not produce two users. The real
   * adapter gets that from a transaction + unique constraint; here it falls out of
   * keying on email.
   */
  async upsertBySsoIdentity(
    provider: string,
    providerSub: string,
    providerEmail: string,
    displayName: string,
  ): Promise<User> {
    const existing = await this.findByEmail(providerEmail);
    const user =
      existing ??
      makeUser({ id: `user-${this.users.size + 1}`, email: providerEmail, displayName });
    this.users.set(user.id, user);

    const key = InMemoryUserRepository.ssoKey(provider, providerSub);
    if (!this.ssoIdentities.has(key)) {
      const now = new Date();
      this.ssoIdentities.set(key, {
        id: `sso-${this.ssoIdentities.size + 1}`,
        userId: user.id,
        provider,
        providerSub,
        providerEmail,
        createdAt: now,
        updatedAt: now,
      });
    }
    return user;
  }
}

export class InMemoryAuthSessionRepository implements IAuthSessionRepository {
  readonly sessions = new Map<string, AuthSession>();

  async findByTokenHash(hash: string): Promise<AuthSession | null> {
    for (const session of this.sessions.values()) if (session.tokenHash === hash) return session;
    return null;
  }

  async create(input: CreateSessionInput): Promise<void> {
    this.sessions.set(input.id, {
      id: input.id,
      contextId: input.contextId,
      userId: input.userId,
      tokenHash: input.tokenHash,
      familyId: input.familyId,
      isRevoked: false,
      expiresAt: input.expiresAt,
      createdAt: new Date(),
      ssoProvider: input.ssoProvider ?? null,
      csrfToken: input.csrfToken ?? null,
    });
  }

  async revokeById(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (session) this.sessions.set(id, { ...session, isRevoked: true });
  }

  /**
   * Compare-and-swap: `true` only for the caller that flipped the flag. This is
   * the contract single-use rotation rests on — two concurrent refreshes with the
   * same token must not both win, or the family ends up with two live sessions.
   */
  async revokeByIdIfActive(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session || session.isRevoked) return false;
    this.sessions.set(id, { ...session, isRevoked: true });
    return true;
  }

  async revokeFamily(familyId: string): Promise<void> {
    for (const [id, session] of this.sessions) {
      if (session.familyId === familyId) this.sessions.set(id, { ...session, isRevoked: true });
    }
  }

  async revokeAllForUser(userId: string): Promise<void> {
    for (const [id, session] of this.sessions) {
      if (session.userId === userId) this.sessions.set(id, { ...session, isRevoked: true });
    }
  }
}

/**
 * Runs the callback with an opaque handle. It does NOT emulate rollback — a fake
 * that pretended to be transactional would hide exactly the bugs a real
 * transaction catches, so tests that care about atomicity belong against a real
 * database.
 */
export class InMemoryTransactionRunner implements ITransactionRunner {
  async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    return fn({});
  }
}

/** Returns whatever claims the test wants in the token. */
export class StubClaimsProvider implements IClaimsProvider {
  constructor(private readonly claims: ProductClaims = {}) {}

  async getClaims(): Promise<ProductClaims> {
    return this.claims;
  }
}

/** Captures audit records so a test can assert what was written. */
export class RecordingAuditService implements IAuditService {
  readonly records: AuditRecordInput[] = [];

  async record(input: AuditRecordInput): Promise<void> {
    this.records.push(input);
  }
}

/** Captures the auth context the guard stamps per request. */
export class RecordingAuthContext implements AuthContextSetter {
  readonly calls: Array<{ contextId: string | null; userId: string; sessionId: string }> = [];

  setAuthContext(contextId: string | null, userId: string, sessionId: string): void {
    this.calls.push({ contextId, userId, sessionId });
  }
}

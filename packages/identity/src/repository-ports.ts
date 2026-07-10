/**
 * Persistence **ports** for the identity bounded context — the interfaces a
 * product's repository layer implements so the shared auth logic never depends
 * on a concrete ORM.
 *
 * Behaviour-preserving port of rally's `domain/ports/*.repository.ts`. The one
 * change is decoupling from the drizzle `DbExecutor`: each transactional method
 * takes an opaque `tx?: Tx` and the interfaces are generic over that transaction
 * type (defaulting to `unknown`). A product binds its own executor, e.g.
 * `class UserDrizzleRepository implements IUserRepository<DbExecutor>`.
 */
import type {
  AuthSession,
  CreateSessionInput,
  SsoConnection,
  SsoIdentity,
  User,
} from './domain-types';

/** DI token for {@link IUserRepository}. */
export const USER_REPOSITORY = Symbol('USER_REPOSITORY');

/**
 * @typeParam Tx - the product's transaction/executor type, threaded through
 * write methods so multi-step operations can share one transaction.
 */
export interface IUserRepository<Tx = unknown> {
  findByEmail(email: string): Promise<User | null>;
  findById(id: string): Promise<User | null>;
  updateLastLogin(id: string, tx?: Tx): Promise<void>;
  updateStatus(id: string, status: string, tx?: Tx): Promise<void>;
  updateProfile(
    id: string,
    input: { displayName?: string; avatarUrl?: string | null; locale?: string; timezone?: string },
  ): Promise<User>;

  /** Look up an existing SSO identity row by provider + providerSub (Entra oid). */
  findSsoIdentity(provider: string, providerSub: string): Promise<SsoIdentity | null>;
  /**
   * JIT provision: find-or-create a user by email, then create the SSO identity
   * link. Runs in a single transaction so duplicate concurrent logins are safe.
   */
  upsertBySsoIdentity(
    provider: string,
    providerSub: string,
    providerEmail: string,
    displayName: string,
    tx?: Tx,
  ): Promise<User>;
}

/** DI token for {@link IAuthSessionRepository}. */
export const AUTH_SESSION_REPOSITORY = Symbol('AUTH_SESSION_REPOSITORY');

/**
 * @typeParam Tx - the product's transaction/executor type.
 */
export interface IAuthSessionRepository<Tx = unknown> {
  findByTokenHash(hash: string): Promise<AuthSession | null>;
  create(input: CreateSessionInput, tx?: Tx): Promise<void>;
  revokeById(id: string, tx?: Tx): Promise<void>;
  /**
   * Atomically revoke a session only if it is still active. Returns `true` if
   * this call flipped `is_revoked` false→true, `false` if it was already
   * revoked (i.e. a concurrent request won the rotation race). Enables
   * single-use refresh-token rotation without creating two live sessions.
   */
  revokeByIdIfActive(id: string, tx?: Tx): Promise<boolean>;
  revokeFamily(familyId: string, tx?: Tx): Promise<void>;
  revokeAllForUser(userId: string, tx?: Tx): Promise<void>;
}

/** DI token for {@link ISsoConnectionRepository}. */
export const SSO_CONNECTION_REPOSITORY = Symbol('SSO_CONNECTION_REPOSITORY');

export interface ISsoConnectionRepository {
  /**
   * Look up an active SSO connection by provider + external IdP tenant id
   * (Entra `tid`). Runs across all workspaces — this is how a federated user is
   * routed to the correct workspace before any workspace context is known.
   */
  findByExternalTenantId(provider: string, externalTenantId: string): Promise<SsoConnection | null>;
}

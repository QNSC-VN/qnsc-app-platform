/**
 * Lightweight domain types for the identity bounded context.
 *
 * These mirror the persisted shape but carry **no ORM dependency** — they are
 * the contract that a product's persistence layer maps onto. Behaviour-
 * preserving port of rally's `libs/modules/identity/src/domain/user.types.ts`.
 */

/** Lifecycle state of a user account. */
export type UserStatus = 'invited' | 'active' | 'inactive' | 'suspended';

export interface User {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  status: UserStatus;
  emailVerified: boolean;
  locale: string;
  timezone: string;
  sessionVersion: number;
  lastLoginAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthSession {
  id: string;
  /**
   * Authorization context scope for the session. Multi-tenant products (rally)
   * store the active workspace id here; single-tenant products (opshub) use
   * `null`. Opaque to the core.
   */
  contextId: string | null;
  userId: string;
  tokenHash: string;
  familyId: string;
  isRevoked: boolean;
  expiresAt: Date;
  createdAt: Date;
  /** SSO provider if the session was created via SSO; null for password sessions. */
  ssoProvider: string | null;
  /** CSRF token for double-submit cookie protection; null for pre-migration sessions. */
  csrfToken: string | null;
}

export interface CreateSessionInput {
  id: string;
  /** Authorization context scope; workspace id for multi-tenant products, `null` otherwise. */
  contextId: string | null;
  userId: string;
  tokenHash: string;
  familyId: string;
  ipAddress?: string;
  expiresAt: Date;
  /** Set to 'entra' for SSO sessions; omit for password sessions. */
  ssoProvider?: string;
  /** CSRF token for double-submit cookie protection. Omit for pre-migration / signup sessions. */
  csrfToken?: string;
}

export interface SsoIdentity {
  id: string;
  userId: string;
  provider: string;
  providerSub: string;
  providerEmail: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Maps an external identity provider (Entra `tid`, SAML/OIDC issuer) to a single
 * workspace. Resolved during SSO login to route a federated user into the
 * correct workspace without relying on an insecure global default.
 */
export interface SsoConnection {
  id: string;
  workspaceId: string;
  provider: string;
  externalTenantId: string;
  issuer: string | null;
  defaultRoleSlug: string;
  allowedEmailDomains: string[];
  jitEnabled: boolean;
  status: 'active' | 'disabled';
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateUserInput {
  email: string;
  displayName: string;
  avatarUrl?: string;
}

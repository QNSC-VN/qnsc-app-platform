/**
 * `AuthService` — the shared identity/auth use-cases.
 *
 * Behaviour-preserving port of rally's `AuthService`, decoupled from the product
 * via the ports/tokens in this package: repository ports, service ports, the
 * transaction runner, the Entra verifier, and {@link AuthServiceOptions}.
 *
 * This slice covers the **login** paths — SSO (Entra ID) and dev-login — plus
 * the just-in-time SSO provisioning they share. Refresh rotation, logout, and
 * workspace switching follow in later slices.
 *
 * Note: rally's `@Span(...)` tracing decorators are intentionally omitted — they
 * are product observability infrastructure, not auth behaviour.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'node:crypto';
import { uuidv7 } from 'uuidv7';
import { UnauthorizedException } from '@qnsc/platform-http';
import { signAccessToken } from './access-token';
import { generateRefreshToken, parseTtlSeconds } from './refresh-token';
import { AUTH_SERVICE_OPTIONS, type AuthServiceOptions } from './auth-options';
import { EntraTokenVerifier } from './entra-verifier';
import type { User } from './domain-types';
import {
  AUTH_SESSION_REPOSITORY,
  SSO_CONNECTION_REPOSITORY,
  USER_REPOSITORY,
  type IAuthSessionRepository,
  type ISsoConnectionRepository,
  type IUserRepository,
} from './repository-ports';
import {
  ACCESS_SERVICE,
  AUDIT_SERVICE,
  WORKSPACE_SERVICE,
  type IAccessService,
  type IAuditService,
  type IWorkspaceService,
  type WorkspaceMembership,
} from './service-ports';
import { TRANSACTION_RUNNER, type ITransactionRunner } from './transaction-runner';

/** Fallback refresh-token lifetime when `jwtRefreshExpiry` is unparseable (30 days). */
const REMEMBER_ME_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  csrfToken: string;
  user: Pick<User, 'id' | 'email' | 'displayName' | 'avatarUrl' | 'locale' | 'timezone'>;
  /** All active workspace memberships, most-recently-active first. Drives the workspace switcher. */
  memberships: WorkspaceMembership[];
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(USER_REPOSITORY) private readonly userRepo: IUserRepository,
    @Inject(AUTH_SESSION_REPOSITORY) private readonly sessionRepo: IAuthSessionRepository,
    @Inject(SSO_CONNECTION_REPOSITORY) private readonly ssoConnectionRepo: ISsoConnectionRepository,
    @Inject(TRANSACTION_RUNNER) private readonly txRunner: ITransactionRunner,
    @Inject(ACCESS_SERVICE) private readonly accessService: IAccessService,
    @Inject(WORKSPACE_SERVICE) private readonly workspaceService: IWorkspaceService,
    @Inject(AUDIT_SERVICE) private readonly audit: IAuditService,
    @Inject(AUTH_SERVICE_OPTIONS) private readonly options: AuthServiceOptions,
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(EntraTokenVerifier) private readonly entraVerifier: EntraTokenVerifier,
  ) {}

  // ---------------------------------------------------------------------------
  // SSO login — Microsoft Entra ID (OIDC)
  // ---------------------------------------------------------------------------

  async ssoLogin(idToken: string, ipAddress?: string): Promise<LoginResult> {
    // Verify signature + claims and extract the normalized identity. The verifier
    // throws SSO_NOT_CONFIGURED / SSO_TOKEN_INVALID / SSO_CLAIMS_MISSING.
    const { oid, email, displayName, externalTenantId } = await this.entraVerifier.verify(idToken);

    // Look up existing SSO identity first (fast path — avoids workspace lookup).
    const existingIdentity = await this.userRepo.findSsoIdentity('entra', oid);

    let user: User;
    let ssoWorkspaceId: string;
    if (existingIdentity) {
      const found = await this.userRepo.findById(existingIdentity.userId);
      if (
        !found ||
        found.deletedAt ||
        found.status === 'suspended' ||
        found.status === 'inactive'
      ) {
        throw new UnauthorizedException('USER_DEACTIVATED', 'Account is not active');
      }
      user = found;
      // Determine active workspace from memberships (most-recently-active first).
      const membershipsEarly = await this.workspaceService.getMemberships(user.id);
      ssoWorkspaceId = membershipsEarly[0]?.workspaceId ?? '';
      if (!ssoWorkspaceId) {
        // Identity exists but the user has no workspace membership (e.g. a prior
        // partial provision linked the SSO identity without enrolling the user).
        // Re-run JIT provisioning via the SSO connection to self-heal rather than
        // hard-failing — resolveAndProvisionSsoUser is idempotent (it upserts the
        // identity and enrolls only if no membership exists) and still enforces
        // the connection's active/domain/JIT guards.
        const reprovisioned = await this.resolveAndProvisionSsoUser({
          oid,
          email,
          displayName,
          externalTenantId,
        });
        user = reprovisioned.user;
        ssoWorkspaceId = reprovisioned.workspaceId;
      }
    } else {
      const provisioned = await this.resolveAndProvisionSsoUser({
        oid,
        email,
        displayName,
        externalTenantId,
      });
      user = provisioned.user;
      ssoWorkspaceId = provisioned.workspaceId;
    }

    // Auto-elevate platform admins to workspace_admin on every SSO login.
    if (this.options.platformAdminEmails.includes(user.email.toLowerCase())) {
      const elevated = await this.accessService.elevateToWorkspaceAdmin(user.id, ssoWorkspaceId);
      if (elevated) {
        void this.audit.record({
          workspaceId: ssoWorkspaceId,
          actorId: user.id,
          actorEmail: user.email,
          action: 'access.role_elevated',
          resourceType: 'user',
          resourceId: user.id,
          ipAddress,
          metadata: { role: 'workspace_admin', via: 'PLATFORM_ADMIN_EMAILS', method: 'sso' },
        });
      }
    }

    const { permissions } = await this.accessService.getUserRoleAndPermissions(
      user.id,
      ssoWorkspaceId,
    );
    const session = await this.createSession({
      user,
      workspaceId: ssoWorkspaceId,
      authMethod: 'sso',
      permissions,
      ipAddress,
      ssoProvider: 'entra',
    });

    this.logger.log(
      { userId: user.id, jti: session.jti, sessionId: session.sessionId, provider: 'entra' },
      'User logged in via SSO',
    );

    void this.audit.record({
      workspaceId: ssoWorkspaceId,
      actorId: user.id,
      actorEmail: user.email,
      action: 'auth.login.sso',
      resourceType: 'session',
      resourceId: session.sessionId,
      ipAddress,
      metadata: { provider: 'entra', oid },
    });

    const memberships = await this.workspaceService.getMemberships(user.id);
    void this.workspaceService.touchMembership(user.id, ssoWorkspaceId);

    return this.toLoginResult(session, user, memberships);
  }

  // ---------------------------------------------------------------------------
  // Dev login — passwordless, non-production only (local development + E2E)
  // ---------------------------------------------------------------------------

  /**
   * Sign in a seeded account by email with no password or IdP round-trip.
   *
   * SSO-only in production; this exists purely so local development and the
   * Playwright E2E suite can authenticate without a real Entra tenant. It is
   * hard-blocked when `nodeEnv` is `'production'` so it can never be used as a
   * passwordless backdoor in a deployed environment.
   */
  async devLogin(email: string, ipAddress?: string): Promise<LoginResult> {
    if (this.options.nodeEnv === 'production') {
      throw new UnauthorizedException('DEV_LOGIN_DISABLED', 'Dev login is disabled in production');
    }

    const normalizedEmail = email.toLowerCase().trim();
    const user = await this.userRepo.findByEmail(normalizedEmail);
    if (!user || user.deletedAt || user.status === 'suspended' || user.status === 'inactive') {
      throw new UnauthorizedException(
        'AUTH_INVALID_CREDENTIALS',
        'No active account exists for this email',
      );
    }

    const memberships = await this.workspaceService.getMemberships(user.id);
    const workspaceId = memberships[0]?.workspaceId;
    if (!workspaceId) {
      throw new UnauthorizedException(
        'ACCOUNT_DEACTIVATED',
        'No active workspace membership found',
      );
    }

    const { permissions } = await this.accessService.getUserRoleAndPermissions(
      user.id,
      workspaceId,
    );
    // authMethod 'password' (not SSO) so the SPA uses plain cookie-based refresh
    // instead of an MSAL silent re-auth for these local sessions.
    const session = await this.createSession({
      user,
      workspaceId,
      authMethod: 'password',
      permissions,
      ipAddress,
    });

    this.logger.log(
      { userId: user.id, jti: session.jti, sessionId: session.sessionId },
      'User logged in via dev-login',
    );

    void this.audit.record({
      workspaceId,
      actorId: user.id,
      actorEmail: user.email,
      action: 'auth.login.dev',
      resourceType: 'session',
      resourceId: session.sessionId,
      ipAddress,
      metadata: { method: 'dev-login' },
    });

    void this.workspaceService.touchMembership(user.id, workspaceId);

    return this.toLoginResult(session, user, memberships);
  }

  // ---------------------------------------------------------------------------
  // SSO provisioning
  // ---------------------------------------------------------------------------

  /**
   * Resolve which workspace a federated (SSO) user belongs to and provision them
   * if needed. Resolution is driven entirely by the SSO connection:
   *
   *   1. SSO connection by Entra tid → provision into the mapped workspace,
   *      subject to the connection's domain allow-list and JIT toggle.
   *   2. Otherwise → 403; the user must be invited by an admin.
   *
   * An unmapped IdP is rejected rather than silently dropped into a default
   * workspace — so a directory the operator hasn't explicitly mapped can't leak in.
   */
  private async resolveAndProvisionSsoUser(input: {
    oid: string;
    email: string;
    displayName: string;
    externalTenantId: string | null;
  }): Promise<{ user: User; workspaceId: string }> {
    const { oid, email, displayName, externalTenantId } = input;

    let connectionWorkspaceId: string | null = null;
    let defaultRoleSlug: string | undefined;

    if (externalTenantId) {
      const connection = await this.ssoConnectionRepo.findByExternalTenantId(
        'entra',
        externalTenantId,
      );
      if (connection) {
        if (connection.status !== 'active') {
          throw new UnauthorizedException(
            'SSO_CONNECTION_DISABLED',
            'SSO for your organization is disabled. Please contact your administrator.',
          );
        }
        if (!this.isEmailDomainAllowed(email, connection.allowedEmailDomains)) {
          throw new UnauthorizedException(
            'SSO_DOMAIN_NOT_ALLOWED',
            'Your email domain is not permitted to sign in to this organization.',
          );
        }
        if (!connection.jitEnabled) {
          throw new UnauthorizedException(
            'SSO_JIT_DISABLED',
            'Automatic account creation is disabled. Please ask your administrator for an invitation.',
          );
        }
        connectionWorkspaceId = connection.workspaceId;
        defaultRoleSlug = connection.defaultRoleSlug;
      }
    }

    if (!connectionWorkspaceId) {
      throw new UnauthorizedException(
        'SSO_NO_ACCESS',
        'No workspace is configured for your organization. Please ask your administrator for an invitation.',
      );
    }

    const workspaceId = connectionWorkspaceId;

    // Upsert the user + SSO identity link. The SSO identity is install-global;
    // workspace membership is handled separately below.
    const user = await this.userRepo.upsertBySsoIdentity('entra', oid, email, displayName);

    // Ensure the user is an active member of the SSO connection's workspace.
    await this.workspaceService.enrollMember(workspaceId, user.id);

    if (defaultRoleSlug) {
      await this.accessService.ensureDefaultRole(user.id, workspaceId, defaultRoleSlug);
    }

    return { user, workspaceId };
  }

  /** Returns true when the email's domain is permitted (empty list = any). */
  private isEmailDomainAllowed(email: string, allowedDomains: string[]): boolean {
    if (!allowedDomains || allowedDomains.length === 0) return true;
    const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
    return allowedDomains.some((d) => d.toLowerCase().trim() === domain);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Seconds a new refresh token stays valid, from `jwtRefreshExpiry`. */
  private refreshTtlSeconds(): number {
    return parseTtlSeconds(this.options.jwtRefreshExpiry, REMEMBER_ME_TTL_SECONDS);
  }

  /**
   * Mint an access + refresh token pair for a resolved user + workspace and
   * persist the session (session row + last-login stamp) in one transaction.
   */
  private async createSession(params: {
    user: User;
    workspaceId: string;
    authMethod: 'password' | 'sso';
    permissions: string[];
    ipAddress?: string;
    ssoProvider?: string;
  }): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    csrfToken: string;
    sessionId: string;
    jti: string;
  }> {
    const sessionId = uuidv7();
    const { accessToken, jti, expiresIn } = signAccessToken(
      (payload) => this.jwt.sign(payload),
      this.options.jwtAccessExpiry,
      {
        userId: params.user.id,
        workspaceId: params.workspaceId,
        sessionId,
        permissions: params.permissions,
        authMethod: params.authMethod,
      },
    );
    const { refreshToken, tokenHash, familyId } = generateRefreshToken();

    const refreshExpiry = new Date();
    refreshExpiry.setSeconds(refreshExpiry.getSeconds() + this.refreshTtlSeconds());

    const csrfToken = randomBytes(32).toString('hex');

    await this.txRunner.transaction(async (tx) => {
      await this.sessionRepo.create(
        {
          id: sessionId,
          workspaceId: params.workspaceId,
          userId: params.user.id,
          tokenHash,
          familyId,
          ipAddress: params.ipAddress,
          expiresAt: refreshExpiry,
          ssoProvider: params.ssoProvider,
          csrfToken,
        },
        tx,
      );
      await this.userRepo.updateLastLogin(params.user.id, tx);
    });

    return { accessToken, refreshToken, expiresIn, csrfToken, sessionId, jti };
  }

  /** Assemble the public {@link LoginResult} from an issued session + user + memberships. */
  private toLoginResult(
    session: { accessToken: string; refreshToken: string; expiresIn: number; csrfToken: string },
    user: User,
    memberships: WorkspaceMembership[],
  ): LoginResult {
    return {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresIn: session.expiresIn,
      csrfToken: session.csrfToken,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        locale: user.locale,
        timezone: user.timezone,
      },
      memberships,
    };
  }
}

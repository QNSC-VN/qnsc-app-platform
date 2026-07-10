/**
 * `AuthService` — the shared identity/auth use-cases.
 *
 * Behaviour-preserving port of rally's `AuthService`, decoupled from the product
 * via the ports/tokens in this package: repository ports, service ports, the
 * transaction runner, the Entra verifier, and {@link AuthServiceOptions}.
 *
 * This slice covers the **login** paths — SSO (Entra ID) and dev-login — the
 * just-in-time SSO provisioning they share, **refresh-token rotation** with
 * single-use theft detection, session teardown (**logout**, **logout-all**,
 * **workspace switching**), and the authenticated user's own **profile**
 * (get/update).
 *
 * Note: rally's `@Span(...)` tracing decorators are intentionally omitted — they
 * are product observability infrastructure, not auth behaviour.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'node:crypto';
import { uuidv7 } from 'uuidv7';
import { ValkeyService } from '@qnsc-vn/platform-cache';
import { NotFoundException, UnauthorizedException } from '@qnsc-vn/platform-http';
import { signAccessToken } from './access-token';
import { CLAIMS_PROVIDER, type IClaimsProvider, type ProductClaims } from './claims-provider';
import { generateRefreshToken, hashToken, parseTtlSeconds } from './refresh-token';
import { AUTH_SERVICE_OPTIONS, type AuthServiceOptions } from './auth-options';
import { EntraTokenVerifier } from './entra-verifier';
import type { AuthSession, User } from './domain-types';
import type { JwtPayload } from './jwt-payload';
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

/**
 * How long a successful refresh-token rotation result is cached (keyed by the
 * consumed token's hash) so a benign concurrent/retried reuse — multiple tabs,
 * a retried request after a lost response, React StrictMode — can replay the
 * same successor tokens instead of tripping single-use theft detection. Kept
 * short so a genuinely stolen, long-dormant token is still caught.
 */
const REFRESH_ROTATION_GRACE_SECONDS = 30;

/**
 * Internal signal used to roll back a rotation transaction when the atomic
 * compare-and-swap revoke is lost to a concurrent refresh.
 */
class RotationLostError extends Error {}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  csrfToken: string;
  user: Pick<User, 'id' | 'email' | 'displayName' | 'avatarUrl' | 'locale' | 'timezone'>;
  /** All active workspace memberships, most-recently-active first. Drives the workspace switcher. */
  memberships: WorkspaceMembership[];
}

export interface RefreshResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  csrfToken: string;
}

/** Mutable profile fields a user may edit via `PATCH /auth/me`. */
export interface UpdateProfileInput {
  displayName?: string;
  avatarUrl?: string | null;
  locale?: string;
  timezone?: string;
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
    @Inject(CLAIMS_PROVIDER) private readonly claimsProvider: IClaimsProvider,
    @Inject(WORKSPACE_SERVICE) private readonly workspaceService: IWorkspaceService,
    @Inject(AUDIT_SERVICE) private readonly audit: IAuditService,
    @Inject(AUTH_SERVICE_OPTIONS) private readonly options: AuthServiceOptions,
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(EntraTokenVerifier) private readonly entraVerifier: EntraTokenVerifier,
    @Inject(ValkeyService) private readonly valkey: ValkeyService,
  ) {}

  // ---------------------------------------------------------------------------
  // Refresh
  // ---------------------------------------------------------------------------

  async refresh(
    rawRefreshToken: string,
    csrfToken: string | null,
    ipAddress?: string,
  ): Promise<RefreshResult> {
    const tokenHash = hashToken(rawRefreshToken);
    const session = await this.sessionRepo.findByTokenHash(tokenHash);

    if (!session) {
      throw new UnauthorizedException('AUTH_TOKEN_INVALID', 'Refresh token not found');
    }

    // The token has already been rotated. This is not automatically theft —
    // multiple tabs, a retried request after a lost response, or React
    // StrictMode can all legitimately replay a single-use token. Replay the
    // cached successor tokens when the reuse is benign; escalate to family
    // revocation only when we are confident it is malicious.
    if (session.isRevoked) {
      return this.replayOrDetectTheft(tokenHash, session, csrfToken, { concurrentLoss: false });
    }

    if (session.expiresAt < new Date()) {
      throw new UnauthorizedException('AUTH_TOKEN_EXPIRED', 'Refresh token has expired');
    }

    const user = await this.userRepo.findById(session.userId);
    // Suspended/inactive accounts must not receive new access tokens.
    if (!user || user.deletedAt || user.status === 'suspended' || user.status === 'inactive') {
      throw new UnauthorizedException('USER_DEACTIVATED', 'User not found or deactivated');
    }

    // Enforce CSRF for sessions that carry a token (all sessions post-migration).
    // Sessions without csrfToken are pre-migration; allow once, new session gets one.
    if (session.csrfToken !== null) {
      if (!csrfToken || csrfToken !== session.csrfToken) {
        throw new UnauthorizedException('AUTH_TOKEN_INVALID', 'CSRF token mismatch');
      }
    }

    // Revoke old session and issue new tokens (rotation).
    const newSessionId = uuidv7();
    // Preserve the auth method across rotations so the frontend knows which
    // refresh path to use (MSAL silent re-auth for SSO vs Rally-only for password).
    const authMethod: 'password' | 'sso' = session.ssoProvider ? 'sso' : 'password';
    const claims = await this.claimsProvider.getClaims(user.id, session.workspaceId);
    const { accessToken, expiresIn } = signAccessToken(
      (payload) => this.jwt.sign(payload),
      this.options.jwtAccessExpiry,
      {
        userId: user.id,
        workspaceId: session.workspaceId,
        sessionId: newSessionId,
        claims,
        authMethod,
      },
    );
    const { refreshToken: newRefreshToken, tokenHash: newHash } = generateRefreshToken();

    const refreshExpiry = new Date();
    refreshExpiry.setSeconds(refreshExpiry.getSeconds() + this.refreshTtlSeconds());

    const newCsrfToken = randomBytes(32).toString('hex');

    const result: RefreshResult = {
      accessToken,
      refreshToken: newRefreshToken,
      expiresIn,
      csrfToken: newCsrfToken,
    };

    // Atomic single-use rotation (compare-and-swap): only one concurrent request
    // may flip is_revoked false→true for this session. The loser must NOT create
    // a second live session (that would defeat single-use) — it replays the
    // winner's cached result instead. Wrapped in a tx so the revoke and the
    // new-session insert commit together or not at all.
    let rotationWon = true;
    try {
      await this.txRunner.transaction(async (tx) => {
        const won = await this.sessionRepo.revokeByIdIfActive(session.id, tx);
        if (!won) {
          rotationWon = false;
          throw new RotationLostError();
        }
        await this.sessionRepo.create(
          {
            id: newSessionId,
            workspaceId: session.workspaceId,
            userId: user.id,
            tokenHash: newHash,
            familyId: session.familyId, // preserve family for revocation chain
            ipAddress,
            expiresAt: refreshExpiry,
            ssoProvider: session.ssoProvider ?? undefined, // carry SSO provider forward
            csrfToken: newCsrfToken,
          },
          tx,
        );
      });
    } catch (err) {
      if (!(err instanceof RotationLostError)) throw err;
    }

    if (!rotationWon) {
      // A concurrent refresh rotated first — replay its result idempotently
      // rather than issuing a competing session or flagging false theft.
      return this.replayOrDetectTheft(tokenHash, session, csrfToken, { concurrentLoss: true });
    }

    // Cache the rotation result under the consumed token's hash so a benign
    // concurrent/retried reuse replays these exact tokens. Best-effort: a cache
    // write failure must not fail the refresh itself.
    try {
      await this.valkey.storeRotationGrace(
        tokenHash,
        JSON.stringify(result),
        REFRESH_ROTATION_GRACE_SECONDS,
      );
    } catch (err) {
      this.logger.warn({ err, sessionId: session.id }, 'Failed to cache rotation grace entry');
    }

    return result;
  }

  /**
   * Handle a refresh whose token has already been rotated. Returns the cached
   * successor tokens when the reuse is benign (within the grace window), or
   * escalates to family revocation (theft) only when we are confident the reuse
   * is malicious.
   *
   * @param concurrentLoss `true` when we lost the atomic rotation CAS (so a
   *   sibling request definitely rotated first — never theft); `false` when the
   *   token was already revoked when we read it (benign replay *or* theft).
   */
  private async replayOrDetectTheft(
    tokenHash: string,
    session: AuthSession,
    csrfToken: string | null,
    { concurrentLoss }: { concurrentLoss: boolean },
  ): Promise<RefreshResult> {
    // CSRF still applies to the replayed response (the revoked session carries
    // the CSRF token the benign client is replaying with).
    if (session.csrfToken !== null && (!csrfToken || csrfToken !== session.csrfToken)) {
      throw new UnauthorizedException('AUTH_TOKEN_INVALID', 'CSRF token mismatch');
    }

    let cached: string | null;
    try {
      // A concurrent winner may not have written its grace entry yet, so poll
      // briefly on the CAS-loss path. A sequential replay needs no polling — the
      // entry, if any, is already present.
      cached = await this.waitForGrace(tokenHash, concurrentLoss ? 6 : 1);
    } catch (err) {
      // Cache unavailable — we cannot prove theft, so fail safe WITHOUT nuking
      // the family (a Valkey blip must never mass-logout every session).
      this.logger.warn({ err, familyId: session.familyId }, 'Rotation grace lookup failed');
      throw new UnauthorizedException('AUTH_TOKEN_INVALID', 'Session refresh unavailable, retry');
    }

    if (cached) {
      return JSON.parse(cached) as RefreshResult;
    }

    if (concurrentLoss) {
      // We KNOW a sibling request rotated this session (we lost the CAS), so this
      // is not theft even though the grace entry is missing/expired. Ask the
      // client to retry with the freshly-set cookie instead of revoking.
      throw new UnauthorizedException('AUTH_TOKEN_INVALID', 'Refresh rotated concurrently, retry');
    }

    // Genuine reuse of a token rotated outside the grace window → treat as
    // session theft and revoke the entire family (session hijacking prevention).
    await this.sessionRepo.revokeFamily(session.familyId);
    this.logger.warn(
      { sessionId: session.id, familyId: session.familyId },
      'Refresh token reuse detected — revoking entire family',
    );
    // Audit trail for security incident detection (SOC 2 CC6.8).
    void this.audit.record({
      workspaceId: session.workspaceId,
      actorId: session.userId,
      action: 'auth.token_theft_detected',
      resourceType: 'session',
      resourceId: session.familyId,
      metadata: { familyId: session.familyId },
    });
    throw new UnauthorizedException('AUTH_REFRESH_TOKEN_REUSE', 'Refresh token has been revoked');
  }

  /** Poll the rotation grace cache up to `tries` times (25ms apart). */
  private async waitForGrace(tokenHash: string, tries: number): Promise<string | null> {
    for (let attempt = 0; attempt < tries; attempt++) {
      const value = await this.valkey.getRotationGrace(tokenHash);
      if (value) return value;
      if (attempt < tries - 1) await sleep(25);
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Logout
  // ---------------------------------------------------------------------------

  /**
   * Log out of the current session: denylist the access token until its natural
   * expiry (so a stolen-but-unexpired token is rejected) and revoke the refresh
   * session in the DB.
   */
  async logout(payload: JwtPayload): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const ttl = Math.max(payload.exp - now, 0);

    await Promise.all([
      // Denylist the access token until it would have expired anyway.
      ttl > 0 ? this.valkey.denylistToken(payload.jti, ttl) : Promise.resolve(),
      // Revoke the refresh session in the DB.
      this.sessionRepo.revokeById(payload.sessionId),
    ]);

    this.logger.log({ userId: payload.sub, jti: payload.jti }, 'User logged out');

    void this.audit.record({
      workspaceId: payload.workspaceId,
      actorId: payload.sub,
      action: 'auth.logout',
      resourceType: 'session',
      resourceId: payload.sessionId,
      metadata: { jti: payload.jti },
    });
  }

  // ---------------------------------------------------------------------------
  // Logout all devices
  // ---------------------------------------------------------------------------

  /**
   * Log out of every session for the user: denylist the current access token and
   * revoke all of the user's refresh sessions across devices.
   */
  async logoutAll(payload: JwtPayload): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const ttl = Math.max(payload.exp - now, 0);

    await Promise.all([
      ttl > 0 ? this.valkey.denylistToken(payload.jti, ttl) : Promise.resolve(),
      this.sessionRepo.revokeAllForUser(payload.sub),
    ]);

    this.logger.log({ userId: payload.sub }, 'User logged out from all devices');
  }

  // ---------------------------------------------------------------------------
  // Switch workspace
  // ---------------------------------------------------------------------------

  /**
   * Issue a fresh token pair scoped to `targetWorkspaceId`, provided the caller
   * has an active membership there. The old access token is denylisted and the
   * old session revoked, and a new session is created — all atomically — so a
   * workspace switch cannot leave two live sessions or a usable stale token.
   */
  async switchWorkspace(
    payload: JwtPayload,
    targetWorkspaceId: string,
    ipAddress?: string,
  ): Promise<RefreshResult> {
    // The caller must be an active member of the target workspace.
    const keycard = await this.workspaceService.getMembership(payload.sub, targetWorkspaceId);
    if (!keycard || keycard.status !== 'active') {
      throw new UnauthorizedException(
        'WORKSPACE_ACCESS_DENIED',
        'You are not a member of this workspace',
      );
    }

    const user = await this.userRepo.findById(payload.sub);
    if (!user || user.deletedAt || user.status === 'suspended' || user.status === 'inactive') {
      throw new UnauthorizedException('USER_DEACTIVATED', 'User not found or deactivated');
    }

    const claims = await this.claimsProvider.getClaims(user.id, targetWorkspaceId);

    const newSessionId = uuidv7();
    // Preserve the auth method across workspace switches so the frontend keeps
    // using the correct refresh path (MSAL silent re-auth for SSO).
    const switchAuthMethod: 'password' | 'sso' = payload.authMethod ?? 'password';
    const { accessToken, jti, expiresIn } = signAccessToken(
      (p) => this.jwt.sign(p),
      this.options.jwtAccessExpiry,
      {
        userId: user.id,
        workspaceId: targetWorkspaceId,
        sessionId: newSessionId,
        claims,
        authMethod: switchAuthMethod,
      },
    );
    const { refreshToken, tokenHash, familyId } = generateRefreshToken();

    const refreshExpiry = new Date();
    refreshExpiry.setSeconds(refreshExpiry.getSeconds() + this.refreshTtlSeconds());

    const csrfToken = randomBytes(32).toString('hex');

    // Denylist the old access token + revoke the old session + create the new
    // session atomically.
    const now = Math.floor(Date.now() / 1000);
    const ttl = Math.max(payload.exp - now, 0);

    await Promise.all([
      ttl > 0 ? this.valkey.denylistToken(payload.jti, ttl) : Promise.resolve(),
      this.txRunner.transaction(async (tx) => {
        await this.sessionRepo.revokeById(payload.sessionId, tx);
        await this.sessionRepo.create(
          {
            id: newSessionId,
            workspaceId: targetWorkspaceId,
            userId: user.id,
            tokenHash,
            familyId,
            ipAddress,
            expiresAt: refreshExpiry,
            csrfToken,
          },
          tx,
        );
      }),
    ]);

    this.logger.log(
      { userId: user.id, jti, sessionId: newSessionId, targetWorkspaceId },
      'Workspace switched',
    );

    void this.workspaceService.touchMembership(user.id, targetWorkspaceId);
    void this.audit.record({
      workspaceId: targetWorkspaceId,
      actorId: user.id,
      actorEmail: user.email,
      action: 'auth.switch_workspace',
      resourceType: 'session',
      resourceId: newSessionId,
      ipAddress,
      metadata: { fromWorkspaceId: payload.workspaceId, toWorkspaceId: targetWorkspaceId },
    });

    return { accessToken, refreshToken, expiresIn, csrfToken };
  }

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

    const claims = await this.claimsProvider.getClaims(user.id, ssoWorkspaceId);
    const session = await this.createSession({
      user,
      workspaceId: ssoWorkspaceId,
      authMethod: 'sso',
      claims,
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

    const claims = await this.claimsProvider.getClaims(user.id, workspaceId);
    // authMethod 'password' (not SSO) so the SPA uses plain cookie-based refresh
    // instead of an MSAL silent re-auth for these local sessions.
    const session = await this.createSession({
      user,
      workspaceId,
      authMethod: 'password',
      claims,
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
  // Profile
  // ---------------------------------------------------------------------------

  /** Fetch the authenticated user's own profile. */
  async getMe(userId: string): Promise<User> {
    const user = await this.userRepo.findById(userId);
    if (!user || user.deletedAt) {
      throw new NotFoundException('USER_NOT_FOUND', 'User not found');
    }
    return user;
  }

  /** Update the authenticated user's own editable profile fields. */
  async updateProfile(userId: string, input: UpdateProfileInput): Promise<User> {
    const user = await this.userRepo.findById(userId);
    if (!user || user.deletedAt) {
      throw new NotFoundException('USER_NOT_FOUND', 'User not found');
    }
    return this.userRepo.updateProfile(userId, input);
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
    claims: ProductClaims;
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
        claims: params.claims,
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

import { Inject, Injectable } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

/** DI token for {@link EntraVerifierOptions}. */
export const ENTRA_VERIFIER_OPTIONS = Symbol('ENTRA_VERIFIER_OPTIONS');

/** Stable failure codes so the consumer can map to its own HTTP error catalog. */
export type SsoVerificationCode = 'SSO_NOT_CONFIGURED' | 'SSO_TOKEN_INVALID' | 'SSO_CLAIMS_MISSING';

/**
 * Raised when an Entra ID token cannot be verified or is missing required
 * claims. Carries a stable {@link SsoVerificationCode} so products can translate
 * it into their own transport-level exception (e.g. a 401 response) without this
 * package depending on any HTTP framework.
 */
export class SsoVerificationError extends Error {
  constructor(
    readonly code: SsoVerificationCode,
    message: string,
  ) {
    super(message);
    this.name = 'SsoVerificationError';
  }
}

/**
 * Configuration for {@link EntraTokenVerifier}. Supplied per product via the
 * {@link ENTRA_VERIFIER_OPTIONS} token instead of reading a global config
 * singleton, so the package stays decoupled from any app config service.
 */
export interface EntraVerifierOptions {
  /** Entra directory (tenant) id — the `{tenant}` segment of the JWKS URL. */
  tenantId: string;
  /** Entra application (client) id — the expected token `aud`. */
  clientId: string;
  /**
   * Accepted token issuers. Defaults to the v2.0 and legacy STS issuers for
   * {@link tenantId}.
   */
  issuers?: string[];
  /**
   * Resolves a JWKS key set for the given URL. Defaults to jose's
   * `createRemoteJWKSet`. Overridable in tests to avoid network access.
   */
  jwksResolver?: (url: URL) => JWTVerifyGetKey;
}

/** Normalized identity claims extracted from a verified Entra ID token. */
export interface EntraClaims {
  /** Entra `oid` — the stable, immutable per-user object id. */
  oid: string;
  /** Lower-cased, trimmed email resolved from `email`/`preferred_username`/`upn`. */
  email: string;
  /** `name` claim, falling back to the email. */
  displayName: string;
  /** Entra `tid` — the external directory id, used to route to a workspace. */
  externalTenantId: string | null;
  /**
   * Entra **App Roles** (`roles`) claim — the app-role values assigned to the
   * user in the app registration. Empty when the token carries no `roles`
   * claim. Products that map IdP roles onto their own authorization model read
   * these via {@link ISsoProvisioningHook} at login.
   */
  roles: string[];
}

/**
 * Verifies Microsoft Entra ID (OIDC) tokens against the tenant's published JWKS
 * and extracts the normalized identity claims used for login / JIT provisioning.
 *
 * Behaviour-preserving port of rally's inline `ssoLogin` verification, decoupled
 * from `AppConfigService` (options token) and from the HTTP layer (throws
 * {@link SsoVerificationError} instead of a framework exception).
 */
@Injectable()
export class EntraTokenVerifier {
  constructor(@Inject(ENTRA_VERIFIER_OPTIONS) private readonly options: EntraVerifierOptions) {}

  /**
   * Verify an Entra ID token's signature + claims and return the normalized
   * identity. Throws {@link SsoVerificationError} on any failure.
   */
  async verify(idToken: string): Promise<EntraClaims> {
    const { tenantId, clientId } = this.options;
    if (!tenantId || !clientId) {
      throw new SsoVerificationError('SSO_NOT_CONFIGURED', 'SSO is not configured on this server');
    }

    const resolve = this.options.jwksResolver ?? createRemoteJWKSet;
    const jwks = resolve(
      new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`),
    );
    const issuers = this.options.issuers ?? [
      `https://login.microsoftonline.com/${tenantId}/v2.0`,
      `https://sts.windows.net/${tenantId}/`,
    ];

    let claims: JWTPayload;
    try {
      const result = await jwtVerify(idToken, jwks, { issuer: issuers, audience: clientId });
      claims = result.payload;
    } catch {
      throw new SsoVerificationError('SSO_TOKEN_INVALID', 'Entra ID token is invalid or expired');
    }

    const oid = typeof claims.oid === 'string' ? claims.oid : null;
    const email =
      typeof claims.email === 'string'
        ? claims.email
        : typeof claims.preferred_username === 'string'
          ? claims.preferred_username
          : typeof claims.upn === 'string'
            ? claims.upn
            : null;
    const displayName = typeof claims.name === 'string' ? claims.name : (email ?? 'Unknown');
    const externalTenantId = typeof claims.tid === 'string' ? claims.tid : null;
    const roles = Array.isArray(claims.roles)
      ? claims.roles.filter((r): r is string => typeof r === 'string')
      : [];

    if (!oid || !email) {
      throw new SsoVerificationError(
        'SSO_CLAIMS_MISSING',
        'Required OIDC claims (oid, email) are missing',
      );
    }

    return { oid, email: email.toLowerCase().trim(), displayName, externalTenantId, roles };
  }
}

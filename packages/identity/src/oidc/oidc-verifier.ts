import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { ResolvedConnection } from './oidc-connection';
import { SsoVerificationError, type EntraClaims } from '../entra-verifier';

/** Broker claims are the same shape provisioning already consumes. */
export type OidcClaims = EntraClaims;

/**
 * Provider-agnostic id_token verifier. Verifies against the resolved
 * connection's accepted issuers + audience (client id) + nonce, then maps to the
 * shared claims shape. One token can only satisfy the connection it was issued
 * for — a foreign issuer/audience is rejected.
 */
export class OidcTokenVerifier {
  private readonly jwksCache = new Map<string, JWTVerifyGetKey>();

  constructor(private readonly jwksResolver: (url: URL) => JWTVerifyGetKey = createRemoteJWKSet) {}

  async verify(
    idToken: string,
    conn: ResolvedConnection,
    expectedNonce?: string,
  ): Promise<OidcClaims> {
    let jwks = this.jwksCache.get(conn.jwksUri);
    if (!jwks) {
      jwks = this.jwksResolver(new URL(conn.jwksUri));
      this.jwksCache.set(conn.jwksUri, jwks);
    }

    const issuers = conn.acceptedIssuers.length > 0 ? conn.acceptedIssuers : [conn.issuer];

    let payload: Record<string, unknown>;
    try {
      ({ payload } = (await jwtVerify(idToken, jwks, {
        issuer: issuers,
        audience: conn.clientId,
      })) as unknown as { payload: Record<string, unknown> });
    } catch (e) {
      throw new SsoVerificationError(
        'SSO_TOKEN_INVALID',
        `Token verification failed: ${(e as Error).message}`,
      );
    }

    // Nonce binds the id_token to the authorize request (reuse SSO_TOKEN_INVALID).
    if (expectedNonce && payload.nonce !== expectedNonce) {
      throw new SsoVerificationError('SSO_TOKEN_INVALID', 'OIDC nonce mismatch');
    }

    const subject = (payload.oid ?? payload.sub) as string | undefined;
    const rawEmail = (payload.email ?? payload.preferred_username ?? payload.upn) as
      | string
      | undefined;
    const email = rawEmail?.toLowerCase().trim();
    if (!subject || !email) {
      throw new SsoVerificationError('SSO_CLAIMS_MISSING', 'Token missing subject/email');
    }

    return {
      oid: subject,
      email,
      displayName: (payload.name as string) ?? email,
      // Retained as descriptive metadata only — routing is connection-driven.
      externalTenantId: (payload.tid as string) ?? null,
      roles: (payload.roles as string[]) ?? [],
    };
  }
}

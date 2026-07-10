/**
 * The `IClaimsProvider` port — how the shared authN core obtains the
 * **product-defined authorization claims** to embed in an access token at
 * mint time.
 *
 * The core owns authentication (SSO verification, sessions, refresh rotation,
 * JWT minting) but is deliberately ignorant of *authorization*: it knows *when*
 * to stamp claims (login, refresh, context switch) but never *what* they are.
 * opshub returns `{ roles }` (RBAC), rally returns `{ permissions }` (PBAC). A
 * product binds its own implementation to {@link CLAIMS_PROVIDER}.
 */

/** Arbitrary product-defined claim bag embedded in the access token. */
export type ProductClaims = Record<string, unknown>;

/** Resolves the authorization claims for a user in an optional authz context. */
export interface IClaimsProvider {
  /**
   * Resolve the claims to embed for `userId`. `contextId` is the optional
   * authorization scope the token is being minted for (rally: the active
   * workspaceId; opshub: `null`/omitted). Called on every token mint so claims
   * are refreshed on each rotation, bounded by the access-token TTL.
   */
  getClaims(userId: string, contextId?: string | null): Promise<ProductClaims>;
}

/** DI token for {@link IClaimsProvider}. */
export const CLAIMS_PROVIDER = Symbol('CLAIMS_PROVIDER');

/**
 * Options for the {@link JwtStrategy}. Each product supplies its own signing
 * material and token issuer/audience, so the strategy stays free of any
 * product-specific config service.
 */
export interface JwtStrategyOptions {
  /** ES256 public key (PEM) used to verify the access-token signature. */
  publicKey: string;
  issuer: string;
  audience: string | string[];
  /** JWT signature algorithms to accept. Defaults to `['ES256']`. */
  algorithms?: string[];
}

/** DI token carrying the resolved {@link JwtStrategyOptions}. */
export const JWT_STRATEGY_OPTIONS = Symbol('JWT_STRATEGY_OPTIONS');

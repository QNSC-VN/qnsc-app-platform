import { createHash, randomBytes } from 'node:crypto';
import { uuidv7 } from 'uuidv7';

/**
 * A freshly minted refresh token and its derived identifiers.
 *
 * - `refreshToken` — the raw, high-entropy secret handed to the client (only
 *   ever stored client-side, in an `HttpOnly` cookie).
 * - `tokenHash` — the SHA-256 hash persisted server-side; the raw token is
 *   never stored, so a DB leak can't be replayed.
 * - `familyId` — links every rotation in a lineage so a detected replay can
 *   revoke the whole family (theft response).
 */
export interface GeneratedRefreshToken {
  refreshToken: string;
  tokenHash: string;
  familyId: string;
}

/**
 * Mint a new refresh token: 32 bytes of CSPRNG entropy (base64url), its SHA-256
 * hash, and a fresh time-ordered family id.
 */
export function generateRefreshToken(): GeneratedRefreshToken {
  const refreshToken = randomBytes(32).toString('base64url');
  const tokenHash = hashToken(refreshToken);
  const familyId = uuidv7();
  return { refreshToken, tokenHash, familyId };
}

/** SHA-256 hex digest of a raw refresh token — the server-side lookup key. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Parse a compact duration string (`30d`, `12h`, `15m`, `45s`) into seconds.
 * Returns `fallbackSeconds` when the input doesn't match the expected shape.
 */
export function parseTtlSeconds(expiry: string, fallbackSeconds: number): number {
  const match = /^(\d+)([smhd])$/.exec(expiry);
  if (!match) return fallbackSeconds;
  const [, n, unit] = match;
  const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return parseInt(n, 10) * (multipliers[unit] ?? 86400);
}

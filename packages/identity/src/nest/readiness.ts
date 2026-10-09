import type { Identity } from '../create-identity';

/**
 * For `/readyz` (WP-9, D7). Better Auth validates the Drizzle schema lazily and then rejects every
 * request while it is wrong, so a drifted schema would otherwise show up as user-facing errors, not
 * as a pod that is not ready. Resolves `ok` or the reason; never throws.
 */
export async function checkIdentityReady(
  auth: Identity,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await auth.api.getSession({ headers: new Headers() });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message.split('\n')[0]! : 'identity not ready',
    };
  }
}

import { expect } from 'vitest';
import type { Client } from './client';

/**
 * Drive an OAuth/OIDC browser flow by hand: start (app) -> IdP authorize -> callback (app).
 * `start` is the app request that returns `{ url }`; every hop is returned for assertions.
 */
export async function followAuthorization(client: Client, authorizeUrl: string) {
  const authz = await client.get(authorizeUrl);
  expect(authz.status, `IdP authorize: ${authz.body}`).toBe(302);
  const callback = await client.get(authz.location!);
  return { authz, callback };
}

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API, signUp, strongPassword, uniqueEmail } from './support/flows';
import { followAuthorization } from './support/oauth';
import { startMockIdp, type MockIdp } from './support/mock-idp';
import { startStack, type Stack } from './support/stack';

/**
 * Criterion 1 — Entra sign-in through the Microsoft provider, restricted to the QNSC tenant.
 *
 * Against a mock Entra-shaped IdP (test/support/mock-idp.ts). Entra itself is not reachable from
 * here; what only the real tenant can prove is listed in the ADR as "manual check".
 */
const TENANT = '11111111-1111-4111-8111-111111111111'; // the QNSC tenant, as a generated stand-in
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const CLIENT_ID = 'spike-client-id';
const CLIENT_SECRET = `spike-${crypto.randomUUID()}`;

describe('C1 Microsoft (Entra) sign-in, tenant-restricted', () => {
  let stack: Stack;
  let idp: MockIdp;
  beforeAll(async () => {
    idp = await startMockIdp();
    stack = await startStack({
      identity: {
        presets: ['staff'],
        microsoft: {
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
          tenantId: TENANT,
          authority: idp.base,
        },
      },
    });
  });
  afterAll(async () => {
    await stack?.stop();
    await idp?.stop();
  });

  async function signInWithMicrosoft(client = stack.client()) {
    const start = await client.post(`${API}/sign-in/social`, {
      provider: 'microsoft',
      callbackURL: '/',
    });
    expect(start.status, start.body).toBe(200);
    const { url } = start.json<{ url: string }>();
    return { client, url, ...(await followAuthorization(client, url)) };
  }

  it("sends the user to THE QNSC TENANT's authorize endpoint, with PKCE and state, and asks for no Graph scope", async () => {
    idp.loginAs({
      sub: 's1',
      oid: crypto.randomUUID(),
      tid: TENANT,
      email: uniqueEmail('alice'),
      name: 'Alice',
    });
    const { url } = await signInWithMicrosoft();
    const u = new URL(url);
    expect(u.origin).toBe(idp.base);
    expect(u.pathname).toBe(`/${TENANT}/oauth2/v2.0/authorize`);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('state')).toBeTruthy();
    expect(u.searchParams.get('client_id')).toBe(CLIENT_ID);
    // `User.Read` + `offline_access` are Better Auth's DEFAULT scopes; the preset removes them.
    expect(u.searchParams.get('scope')).toBe('openid profile email');
  });

  it('signs a tenant member in: session cookie, user verified, account keyed by the Entra oid', async () => {
    const oid = crypto.randomUUID();
    const email = uniqueEmail('bob');
    idp.loginAs({ sub: 's2', oid, tid: TENANT, email, name: 'Bob' });
    const { client, callback } = await signInWithMicrosoft();
    expect(callback.status).toBe(302);
    expect(callback.location).toMatch(/\/$/);

    expect((await client.get('/v1/me')).json()).toMatchObject({ email });
    const { rows } = await stack.pool.query<{
      provider_id: string;
      account_id: string;
      email_verified: boolean;
    }>(
      `select a.provider_id, a.account_id, u.email_verified
         from identity.account a join identity."user" u on u.id = a.user_id where u.email = $1`,
      [email],
    );
    expect(rows).toEqual([{ provider_id: 'microsoft', account_id: oid, email_verified: true }]);
  });

  it("the token request goes to the tenant's token endpoint, with the PKCE verifier", async () => {
    idp.requests.length = 0;
    idp.loginAs({ sub: 's3', oid: crypto.randomUUID(), tid: TENANT, email: uniqueEmail('carol') });
    await signInWithMicrosoft();
    const tokenCall = idp.requests.find(
      (r) => r.method === 'POST' && r.path.endsWith('/oauth2/v2.0/token'),
    )!;
    expect(tokenCall.path).toBe(`/${TENANT}/oauth2/v2.0/token`);
    expect(tokenCall.form!['code_verifier']).toBeTruthy();
    expect(tokenCall.form!['grant_type']).toBe('authorization_code');
  });

  it('does NOT call Microsoft Graph for a profile photo (disabled in the preset)', async () => {
    // The default getUserInfo GETs graph.microsoft.com/v1.0/me/photos with the access token.
    // The default getUserInfo is replaced (it is where the Graph call lives). Prove it by the
    // absence of any request to graph.microsoft.com: the IdP mock is the only host reachable.
    idp.loginAs({
      sub: 's-nophoto',
      oid: crypto.randomUUID(),
      tid: TENANT,
      email: uniqueEmail('nophoto'),
    });
    const originalFetch = globalThis.fetch;
    const hosts = new Set<string>();
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      hosts.add(
        new URL(typeof input === 'string' || input instanceof URL ? input : input.url).host,
      );
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      await signInWithMicrosoft();
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect([...hosts].some((h) => h.includes('graph.microsoft.com'))).toBe(false);
  });

  it('REFUSES an id_token from another tenant (tid mismatch) and writes no user', async () => {
    const email = uniqueEmail('mallory');
    idp.loginAs({ sub: 's4', oid: crypto.randomUUID(), tid: OTHER_TENANT, email, name: 'Mallory' });
    const { client, callback } = await signInWithMicrosoft();
    expect(callback.status).toBe(302);
    expect(callback.location).toMatch(/error=unable_to_get_user_info/);
    expect((await client.get('/v1/me')).status).toBe(401);
    const { rows } = await stack.pool.query(`select 1 from identity."user" where email = $1`, [
      email,
    ]);
    expect(rows).toHaveLength(0);
  });

  it('DIFFERENCE: without that preset check, Better Auth would accept the foreign-tenant token', async () => {
    // Same IdP behaviour, preset check removed: the code flow does not verify `tid`/`iss`.
    const loose = await startStack({
      identity: {
        presets: ['staff'],
        microsoft: {
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
          tenantId: TENANT,
          authority: idp.base,
        },
      },
    });
    try {
      // Swap in a getUserInfo WITHOUT the tid check (what the library's default does).
      (
        loose.auth.options.socialProviders!.microsoft as unknown as { getUserInfo: unknown }
      ).getUserInfo = async (token: { idToken?: string }) => {
        const { decodeJwt } = await import('jose');
        const p = decodeJwt(token.idToken!);
        return {
          user: {
            id: p['oid'] as string,
            name: 'x',
            email: p['email'] as string,
            emailVerified: true,
          },
          data: p,
        };
      };
      const email = uniqueEmail('mallory-loose');
      idp.loginAs({ sub: 's5', oid: crypto.randomUUID(), tid: OTHER_TENANT, email });
      const c = loose.client();
      const start = await c.post(`${API}/sign-in/social`, {
        provider: 'microsoft',
        callbackURL: '/',
      });
      await followAuthorization(c, start.json<{ url: string }>().url);
      const me = await c.get('/v1/me');
      console.info(
        `[C1] foreign-tenant token WITHOUT the preset's tid check -> /v1/me ${me.status}`,
      );
      expect(me.status).toBe(200);
    } finally {
      await loose.stop();
    }
  });

  it('a token without an `email` claim cannot sign in (Entra optional claim must be configured)', async () => {
    idp.loginAs({ sub: 's6', oid: crypto.randomUUID(), tid: TENANT, name: 'No Email' });
    const { client, callback } = await signInWithMicrosoft();
    expect(callback.location).toMatch(/error=/);
    expect((await client.get('/v1/me')).status).toBe(401);
  });

  it('is the only way in: the staff preset has no password sign-up or sign-in', async () => {
    const res = await signUp(stack.client(), uniqueEmail('p'), strongPassword()).catch(
      (e: Error) => e,
    );
    expect(res).toBeInstanceOf(Error); // signUp() asserts 200; the staff preset answers 400
  });

  it('a state value the app did not issue is refused (CSRF on the callback)', async () => {
    idp.loginAs({ sub: 's7', oid: crypto.randomUUID(), tid: TENANT, email: uniqueEmail('forged') });
    const c = stack.client();
    const cb = await c.get(`${API}/callback/microsoft?code=whatever&state=forged-state`);
    expect(cb.status).toBe(302);
    expect(cb.location).toMatch(/error=/);
    expect((await c.get('/v1/me')).status).toBe(401);
  });

  it("PRE-HIJACK: a squatted, unverified password account blocks (does not hijack) the real owner's Microsoft sign-in", async () => {
    // The attacker registers the victim's staff address with a password only they know. The
    // account stays unverified (no mailbox access), so it cannot sign in. The victim then arrives
    // via Microsoft. Better Auth REFUSES to link onto an unverified local account
    // (`requireLocalEmailVerified` defaults to true): safe — the attacker's password never gains
    // the victim's access — but the victim is locked out until the squatter row is removed.
    const open = await startStack({
      identity: {
        presets: ['public', 'staff'],
        microsoft: {
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
          tenantId: TENANT,
          authority: idp.base,
        },
      },
    });
    try {
      const email = uniqueEmail('victim');
      const attackerPassword = strongPassword();
      await signUp(open.client(), email, attackerPassword);
      idp.loginAs({ sub: 's8', oid: crypto.randomUUID(), tid: TENANT, email, name: 'Victim' });
      const c = open.client();
      const start = await c.post(`${API}/sign-in/social`, {
        provider: 'microsoft',
        callbackURL: '/',
      });
      const { callback } = await followAuthorization(c, start.json<{ url: string }>().url);
      expect(callback.location).toMatch(/error=account_not_linked/);
      expect((await c.get('/v1/me')).status).toBe(401);
      // and the attacker still cannot use the password
      const attacker = await open
        .client()
        .post(`${API}/sign-in/email`, { email, password: attackerPassword });
      expect(attacker.status).toBe(403);
      expect(attacker.json()).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
      // Remedy lives in the product: expire unverified accounts, or run staff-only without `public`.
      await open.pool.query(`delete from identity."user" where email = $1`, [email]);
      const again = open.client();
      const s2 = await again.post(`${API}/sign-in/social`, {
        provider: 'microsoft',
        callbackURL: '/',
      });
      await followAuthorization(again, s2.json<{ url: string }>().url);
      expect((await again.get('/v1/me')).status).toBe(200);
    } finally {
      await open.stop();
    }
  });
});

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API, signIn, strongPassword, uniqueEmail, verifiedUser } from './support/flows';
import { followAuthorization } from './support/oauth';
import { startMockIdp, type MockIdp } from './support/mock-idp';
import { startStack, type Stack } from './support/stack';
import type { Client } from './support/client';

/**
 * Criterion 2 — a second IdP as a per-organization `sso` provider, with domain routing and
 * organization provisioning with a default role.
 *
 * "Partner U" is a university with its own OIDC IdP (the generic half of the mock). Its provider
 * row is created the way a product would: by code, with the registration API switched off.
 */
const CLIENT_ID = 'partner-client';
const CLIENT_SECRET = `partner-${randomUUID()}`;

interface Seeded {
  organizationId: string;
  providerId: string;
}

/** Create an organization + a provider row directly: what a product's admin tool / migration does. */
async function seedPartner(
  stack: Stack,
  idp: MockIdp,
  opts: { name: string; domain: string; slug?: string; verified?: boolean },
): Promise<Seeded> {
  const organizationId = randomUUID();
  const providerId = `sso-${opts.slug ?? opts.name.toLowerCase().replace(/\W+/g, '-')}`;
  await stack.pool.query(
    `insert into identity.organization (id, name, slug, created_at) values ($1, $2, $3, now())`,
    [organizationId, opts.name, opts.slug ?? opts.name.toLowerCase().replace(/\W+/g, '-')],
  );
  await stack.pool.query(
    `insert into identity.sso_provider (id, issuer, oidc_config, user_id, provider_id, organization_id, domain, domain_verified)
     select uuidv7(), $1, $2, (select id from identity."user" limit 1), $3, $4, $5, $6`,
    [
      `${idp.base}/oidc`,
      JSON.stringify({
        issuer: `${idp.base}/oidc`,
        pkce: true,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        discoveryEndpoint: `${idp.base}/.well-known/openid-configuration`,
        authorizationEndpoint: `${idp.base}/oidc/authorize`,
        tokenEndpoint: `${idp.base}/oidc/token`,
        jwksEndpoint: `${idp.base}/oidc/jwks`,
        scopes: ['openid', 'email', 'profile'],
        tokenEndpointAuthentication: 'client_secret_post',
        mapping: {
          email: 'email',
          emailVerified: 'email_verified',
          name: 'name',
          extraFields: { groups: 'groups' },
        },
      }),
      providerId,
      organizationId,
      opts.domain,
      opts.verified ?? true,
    ],
  );
  return { organizationId, providerId };
}

async function ssoSignIn(client: Client, body: Record<string, unknown>) {
  const start = await client.post(`${API}/sign-in/sso`, { callbackURL: '/', ...body });
  if (start.status !== 200) return { start } as const;
  const { url } = start.json<{ url: string }>();
  return { start, ...(await followAuthorization(client, url)) } as const;
}

describe('C2 per-organization SSO (OIDC) on a second IdP', () => {
  let stack: Stack;
  let idp: MockIdp;
  const provisioned: Array<{ email: string; claims: Record<string, unknown> }> = [];
  let partner: Seeded;

  beforeAll(async () => {
    idp = await startMockIdp();
    stack = await startStack({
      // The IdP's origin must be a trusted origin for OIDC discovery (see the DIFFERENCE test).
      extraTrustedOrigins: [idp.base],
      identity: {
        presets: ['public', 'organizations'],
        hooks: {
          onSsoProvisioned: (user, userInfo) => {
            provisioned.push({ email: user.email, claims: userInfo });
          },
        },
      },
    });
    // a seed user to own the provider rows (user_id is NOT NULL)
    await verifiedUser(stack, uniqueEmail('owner'), strongPassword());
    partner = await seedPartner(stack, idp, { name: 'Partner U', domain: 'partner-u.test' });
  });
  afterAll(async () => {
    await stack?.stop();
    await idp?.stop();
  });

  it('routes by the email DOMAIN to the right provider and authenticates at the second IdP', async () => {
    idp.loginAs({ sub: 'p-1', email: 'dana@partner-u.test', name: 'Dana' });
    const r = await ssoSignIn(stack.client(), { email: 'dana@partner-u.test' });
    if (!('callback' in r))
      throw new Error(`sign-in/sso failed: ${r.start.status} ${r.start.body}`);
    expect(r.callback.status).toBe(302);
    expect(r.callback.location).toBe('/');
    expect(idp.requests.some((q) => q.path === '/oidc/token' && q.form?.['code_verifier'])).toBe(
      true,
    ); // PKCE
  });

  it('provisions a user AND an organization membership with the DEFAULT ROLE', async () => {
    const email = 'erin@partner-u.test';
    idp.loginAs({ sub: 'p-2', email, name: 'Erin' });
    const c = stack.client();
    const r = await ssoSignIn(c, { email });
    expect('callback' in r && r.callback.status).toBe(302);
    expect((await c.get('/v1/me')).json()).toMatchObject({ email });

    const { rows } = await stack.pool.query<{
      role: string;
      organization_id: string;
      email_verified: boolean;
    }>(
      `select m.role, m.organization_id, u.email_verified
         from identity.member m join identity."user" u on u.id = m.user_id where u.email = $1`,
      [email],
    );
    // DIFFERENCE: the SSO-created user is NOT marked email-verified, even for a domain-verified
    // provider and a matching address. Better Auth sets `emailVerified` from the IdP claim only
    // when the (deprecated) `trustEmailVerified` option is on.
    expect(rows).toEqual([
      { role: 'member', organization_id: partner.organizationId, email_verified: false },
    ]);
    const acct = await stack.pool.query(
      `select a.provider_id from identity.account a join identity."user" u on u.id = a.user_id where u.email = $1`,
      [email],
    );
    expect(acct.rows[0].provider_id).toBe(partner.providerId);
  });

  it("the provisioning hook receives the IdP's claims (v7's sso-provisioning-hook equivalent)", async () => {
    const email = 'finn@partner-u.test';
    idp.loginAs({ sub: 'p-3', email, name: 'Finn', claims: { groups: ['instructors'] } });
    await ssoSignIn(stack.client(), { email });
    const hit = provisioned.find((p) => p.email === email);
    expect(hit?.claims).toMatchObject({ email, groups: ['instructors'] });
  });

  it('a second sign-in does not re-provision or duplicate the membership', async () => {
    const email = 'erin@partner-u.test';
    idp.loginAs({ sub: 'p-2', email, name: 'Erin' });
    await ssoSignIn(stack.client(), { email });
    const { rows } = await stack.pool.query(
      `select 1 from identity.member m join identity."user" u on u.id = m.user_id where u.email = $1`,
      [email],
    );
    expect(rows).toHaveLength(1);
  });

  it('domain routing: unknown domains, look-alike suffixes and sub-domains', async () => {
    const unknown = await ssoSignIn(stack.client(), { email: 'x@nobody.test' });
    expect(unknown.start.status).toBe(404);
    const lookalike = await ssoSignIn(stack.client(), { email: 'x@evilpartner-u.test' });
    expect(lookalike.start.status).toBe(404); // must NOT match by naive suffix
    const sub = await ssoSignIn(stack.client(), { email: 'x@cs.partner-u.test' });
    console.info(
      `[C2 routing] sub-domain cs.partner-u.test -> ${sub.start.status}; lookalike -> ${lookalike.start.status}; unknown -> ${unknown.start.status}`,
    );
  });

  it('routes by explicit providerId and by organization slug too', async () => {
    idp.loginAs({ sub: 'p-4', email: 'gia@partner-u.test', name: 'Gia' });
    const byId = await ssoSignIn(stack.client(), { providerId: partner.providerId });
    expect('callback' in byId && byId.callback.status).toBe(302);
    idp.loginAs({ sub: 'p-5', email: 'hal@partner-u.test', name: 'Hal' });
    const byOrg = await ssoSignIn(stack.client(), { organizationSlug: 'partner-u' });
    expect('callback' in byOrg && byOrg.callback.status).toBe(302);
  });

  it('a second organization with its own domain provisions into ITS org, not the first', async () => {
    const other = await seedPartner(stack, idp, { name: 'Other Corp', domain: 'other-corp.test' });
    idp.loginAs({ sub: 'o-1', email: 'ivy@other-corp.test', name: 'Ivy' });
    await ssoSignIn(stack.client(), { email: 'ivy@other-corp.test' });
    const { rows } = await stack.pool.query<{ organization_id: string }>(
      `select m.organization_id from identity.member m join identity."user" u on u.id = m.user_id where u.email = 'ivy@other-corp.test'`,
    );
    expect(rows).toEqual([{ organization_id: other.organizationId }]);
  });

  it("REFUSES an assertion whose email is outside the provider's domain", async () => {
    // The partner IdP (or anyone holding its client secret) asserts an address at a DIFFERENT domain.
    idp.loginAs({ sub: 'p-6', email: 'ceo@qnsc.test', name: 'Not Partner' });
    const c = stack.client();
    const r = await ssoSignIn(c, { email: 'jay@partner-u.test' });
    const location = 'callback' in r ? r.callback.location : '';
    const me = await c.get('/v1/me');
    const { rows } = await stack.pool.query(
      `select 1 from identity."user" where email = 'ceo@qnsc.test'`,
    );
    console.info(
      `[C2 domain-binding] foreign-domain assertion -> callback ${location} /v1/me ${me.status} user rows ${rows.length}`,
    );
    expect(me.status).toBe(401);
    expect(rows).toHaveLength(0);
  });

  it('DIFFERENCE: without the resolveUser binding, a DOMAIN-VERIFIED provider still creates a user for a foreign address', async () => {
    const unbound = await startStack({
      extraTrustedOrigins: [idp.base],
      identity: { presets: ['public', 'organizations'], spike: { sso: { bindDomain: false } } },
    });
    try {
      await verifiedUser(unbound, uniqueEmail('owner4'), strongPassword());
      await seedPartner(unbound, idp, { name: 'Loose U', domain: 'loose-u.test' });
      idp.loginAs({ sub: 'l-1', email: 'ceo@qnsc.test', name: 'Not Loose' });
      await ssoSignIn(unbound.client(), { email: 'x@loose-u.test' });
      const { rows } = await unbound.pool.query(
        `select 1 from identity."user" where email = 'ceo@qnsc.test'`,
      );
      expect(rows).toHaveLength(1); // Better Auth alone does not bind the asserted address
    } finally {
      await unbound.stop();
    }
  });

  it("LINKS an SSO sign-in onto an existing verified local account when the provider's domain is verified", async () => {
    // A learner registered kim@partner-u.test with a password and verified it. The partner IdP
    // later asserts the same address. Because partner-u.test is a VERIFIED domain of that provider,
    // Better Auth links the SSO identity to the existing user: the partner IdP can now sign in as
    // every local user of its domain. Intended for corporate SSO; worth knowing for open ones.
    const email = 'kim@partner-u.test';
    const password = strongPassword();
    await verifiedUser(stack, email, password);
    idp.loginAs({ sub: 'p-7', email, name: 'Kim (IdP)' });
    const c = stack.client();
    const r = await ssoSignIn(c, { email });
    const location = 'callback' in r ? r.callback.location : '';
    console.info(`[C2 linking] existing verified local account + SSO assertion -> ${location}`);
    const accounts = await stack.pool.query<{ provider_id: string }>(
      `select a.provider_id from identity.account a join identity."user" u on u.id = a.user_id where u.email = $1 order by 1`,
      [email],
    );
    console.info(
      `[C2 linking] accounts on that user afterwards: ${accounts.rows.map((a) => a.provider_id).join(',')}`,
    );
    expect(accounts.rows.map((a) => a.provider_id)).toEqual(['credential', partner.providerId]);
    expect((await c.get('/v1/me')).json()).toMatchObject({ email });
    expect((await signIn(stack.client(), email, password)).status).toBe(200); // password still works
  });

  it('role mapping from an IdP claim (v7 defaultRoleSlug / per-claim role) via getRole', async () => {
    const withRole = await startStack({
      extraTrustedOrigins: [idp.base],
      identity: {
        presets: ['public', 'organizations'],
        spike: {
          sso: {
            getRole: async ({ userInfo }) =>
              (userInfo['groups'] as string[] | undefined)?.includes('admins') ? 'admin' : 'member',
          },
        },
      },
    });
    try {
      await verifiedUser(withRole, uniqueEmail('owner2'), strongPassword());
      const seeded = await seedPartner(withRole, idp, { name: 'Roles U', domain: 'roles-u.test' });
      idp.loginAs({ sub: 'r-1', email: 'lee@roles-u.test', claims: { groups: ['admins'] } });
      await ssoSignIn(withRole.client(), { email: 'lee@roles-u.test' });
      idp.loginAs({ sub: 'r-2', email: 'moe@roles-u.test', claims: { groups: [] } });
      await ssoSignIn(withRole.client(), { email: 'moe@roles-u.test' });
      const { rows } = await withRole.pool.query<{ email: string; role: string }>(
        `select u.email, m.role from identity.member m join identity."user" u on u.id = m.user_id
          where m.organization_id = $1 order by 1`,
        [seeded.organizationId],
      );
      expect(rows).toEqual([
        { email: 'lee@roles-u.test', role: 'admin' },
        { email: 'moe@roles-u.test', role: 'member' },
      ]);
    } finally {
      await withRole.stop();
    }
  });

  it('JIT off (v7 jitEnabled=false): an unknown user is refused unless sign-up is explicitly requested', async () => {
    const jitOff = await startStack({
      extraTrustedOrigins: [idp.base],
      identity: {
        presets: ['public', 'organizations'],
        spike: { sso: { disableImplicitSignUp: true } },
      },
    });
    try {
      await verifiedUser(jitOff, uniqueEmail('owner3'), strongPassword());
      await seedPartner(jitOff, idp, { name: 'Closed U', domain: 'closed-u.test' });
      idp.loginAs({ sub: 'c-1', email: 'nat@closed-u.test' });
      const c = jitOff.client();
      const r = await ssoSignIn(c, { email: 'nat@closed-u.test' });
      expect('callback' in r && r.callback.location).toMatch(/error=/);
      expect((await c.get('/v1/me')).status).toBe(401);
      // pre-created ("break-glass"/admin-created) user is let in
      await jitOff.pool.query(
        `insert into identity."user" (id, name, email, email_verified, created_at, updated_at)
         values (uuidv7(), 'Nat', 'nat@closed-u.test', true, now(), now())`,
      );
      idp.loginAs({ sub: 'c-1', email: 'nat@closed-u.test' });
      const c2 = jitOff.client();
      await ssoSignIn(c2, { email: 'nat@closed-u.test' });
      console.info(
        `[C2 JIT-off] pre-created user after SSO -> /v1/me ${(await c2.get('/v1/me')).status}`,
      );
    } finally {
      await jitOff.stop();
    }
  });
});

describe('C2 DIFFERENCE: the IdP origin must be trusted', () => {
  it('an IdP whose origin is NOT in trustedOrigins cannot be used (discovery and sign-in refuse it)', async () => {
    const idp = await startMockIdp();
    const stack = await startStack({ identity: { presets: ['public', 'organizations'] } }); // IdP not trusted
    try {
      await verifiedUser(stack, uniqueEmail('owner'), strongPassword());
      // Provider stored with ONLY the discovery endpoint, as registered through the API.
      const org = randomUUID();
      await stack.pool.query(
        `insert into identity.organization (id, name, slug, created_at) values ($1, 'Far U', 'far-u', now())`,
        [org],
      );
      await stack.pool.query(
        `insert into identity.sso_provider (id, issuer, oidc_config, user_id, provider_id, organization_id, domain, domain_verified)
         select uuidv7(), $1, $2, (select id from identity."user" limit 1), 'far', $3, 'far-u.test', true`,
        [
          `${idp.base}/oidc`,
          JSON.stringify({
            issuer: `${idp.base}/oidc`,
            pkce: true,
            clientId: CLIENT_ID,
            clientSecret: CLIENT_SECRET,
            discoveryEndpoint: `${idp.base}/.well-known/openid-configuration`,
            mapping: { email: 'email', emailVerified: 'email_verified', name: 'name' },
          }),
          org,
        ],
      );
      idp.loginAs({ sub: 'f-1', email: 'zed@far-u.test' });
      const r = await ssoSignIn(stack.client(), { email: 'zed@far-u.test' });
      console.info(
        `[C2 trust] untrusted IdP origin -> sign-in/sso ${r.start.status} ${r.start.status !== 200 ? r.start.body.slice(0, 160) : ''}`,
      );
      expect(r.start.status).not.toBe(200);
    } finally {
      await stack.stop();
      await idp.stop();
    }
  });
});

describe('C2 trustedOrigins as a function: partner IdP origins from the database', () => {
  it("an IdP becomes usable when the product's trustedOrigins function returns its origin", async () => {
    const idp = await startMockIdp();
    let stack: Stack | undefined;
    try {
      const origins = new Set<string>();
      stack = await startStack({
        identity: {
          presets: ['public', 'organizations'],
          // The product derives the list from its own provider table; here a mutable set stands in.
          trustedOrigins: () => [...origins],
        },
      });
      // `startStack` puts the app's own origin first; replace the function to include it.
      origins.add(stack.url);
      await verifiedUser(stack, uniqueEmail('owner'), strongPassword());
      await seedPartner(stack, idp, { name: 'Dyn U', domain: 'dyn-u.test' });
      idp.loginAs({ sub: 'd-1', email: 'amy@dyn-u.test' });

      const before = await ssoSignIn(stack.client(), { email: 'amy@dyn-u.test' });
      expect(before.start.status).not.toBe(200); // IdP origin not (yet) trusted

      origins.add(idp.base); // e.g. a provider row was inserted; the function now returns it
      const after = await ssoSignIn(stack.client(), { email: 'amy@dyn-u.test' });
      expect('callback' in after && after.callback.status).toBe(302);
      console.info(
        '[C2 dynamic trust] function-valued trustedOrigins is honoured for OIDC discovery',
      );
    } finally {
      await stack?.stop();
      await idp.stop();
    }
  });
});

describe('C2 provider registration through the API', () => {
  let stack: Stack;
  let idp: MockIdp;
  beforeAll(async () => {
    idp = await startMockIdp();
  });
  afterAll(async () => {
    await stack?.stop();
    await idp?.stop();
  });

  const registration = (idpBase: string, domain: string) => ({
    providerId: `reg-${randomUUID().slice(0, 8)}`,
    issuer: `${idpBase}/oidc`,
    domain,
    oidcConfig: {
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      discoveryEndpoint: `${idpBase}/.well-known/openid-configuration`,
      pkce: true,
      mapping: {
        email: 'email',
        emailVerified: 'email_verified',
        name: 'name',
        extraFields: { groups: 'groups' },
      },
    },
  });

  it('DEFAULT (providersLimit 10): ANY signed-in user can register an IdP that claims ANY domain, but it is unusable until the domain is verified', async () => {
    stack = await startStack({
      extraTrustedOrigins: [idp.base],
      identity: { presets: ['public', 'organizations'], spike: { sso: { providersLimit: 10 } } },
    });
    const attacker = await verifiedUser(stack, uniqueEmail('attacker'), strongPassword());
    const res = await attacker.post(
      `${API}/sso/register`,
      registration(idp.base, 'victim-corp.test'),
    );
    console.info(
      `[C2 registration] unprivileged user registers an IdP for victim-corp.test -> ${res.status} ${res.body.slice(0, 120)}`,
    );
    // Registration SUCCEEDS for an unprivileged user (the risk). What stops the abuse is domain
    // verification: the provider is unusable until the domain's DNS TXT proof is checked.
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({ domainVerified: false });
    idp.loginAs({ sub: 'x-1', email: 'boss@victim-corp.test' });
    const use = await ssoSignIn(stack.client(), { email: 'boss@victim-corp.test' });
    expect(use.start.status).toBe(401);
    expect(use.start.json()).toMatchObject({ message: 'Provider domain has not been verified' });
    await stack.stop();
  });

  it('PRESET (providersLimit 0): the registration API is closed to everyone, admins included', async () => {
    stack = await startStack({ identity: { presets: ['public', 'organizations'] } });
    const adminEmail = uniqueEmail('anyone');
    const user = await verifiedUser(stack, adminEmail, strongPassword());
    await stack.pool.query(`update identity."user" set role = 'admin' where email = $1`, [
      adminEmail,
    ]);
    const res = await user.post(`${API}/sso/register`, registration(idp.base, 'victim-corp.test'));
    expect(res.status).toBe(403);
    expect(res.json()).toMatchObject({ message: 'SSO provider registration is disabled' });
    void user;
  });

  it('the client secret is stored in the provider row as configured (a stored-secret decision for WP-10)', async () => {
    stack = await startStack({
      extraTrustedOrigins: [idp.base],
      identity: { presets: ['public', 'organizations'], spike: { sso: { providersLimit: 10 } } },
    });
    const owner = await verifiedUser(stack, uniqueEmail('owner'), strongPassword());
    const org = await owner.post(`${API}/organization/create`, {
      name: 'Reg Org',
      slug: `reg-${randomUUID().slice(0, 6)}`,
    });
    expect(org.status, org.body).toBe(200);
    const orgId = org.json<{ id: string }>().id;
    const body = { ...registration(idp.base, 'reg-org.test'), organizationId: orgId };
    const res = await owner.post(`${API}/sso/register`, body);
    console.info(
      `[C2 registration] org owner registers a provider -> ${res.status} ${res.status !== 200 ? res.body.slice(0, 200) : ''}`,
    );
    if (res.status === 200) {
      const { rows } = await stack.pool.query<{ oidc_config: string }>(
        `select oidc_config from identity.sso_provider limit 1`,
      );
      const stored = JSON.parse(rows[0]!.oidc_config) as { clientSecret: string };
      console.info(
        `[C2 secret] clientSecret stored ${stored.clientSecret === CLIENT_SECRET ? 'IN PLAIN TEXT' : 'transformed (encrypted/hashed)'}`,
      );
    }
  });
});

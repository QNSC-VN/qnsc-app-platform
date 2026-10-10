import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { hash as argon2hash } from '@node-rs/argon2';
import { DEFAULTS } from '../defaults';
import { signDeviceValue } from '../known-device';
import { lockoutKeys } from '../lockout';
import { verifiedUser, signIn } from './flows';
import {
  API,
  STAFF_DOMAIN,
  TEST_TENANT,
  startStack,
  strongPassword,
  uniqueEmail,
  type ConformanceInfra,
  type Stack,
} from './harness';
import { startMockIdp, type MockIdp } from './mock-idp';
import {
  createOrganization,
  microsoftSignIn,
  registerPartner,
  ssoSignIn,
  type TestApi,
} from './support';

/**
 * Findings of the review of PR #168. Each `it` fails against the code as first submitted; the name
 * says which finding it pins.
 */
export function hardeningConformance(t: TestApi, infra: ConformanceInfra): void {
  const { describe, it, expect } = t;

  describe('review S1: trustedOrigins is static; organization creation is closed', () => {
    it('an SSO provider registered by an organization does NOT make its origin a trusted redirect target', async () => {
      const stack = await startStack(infra, { presets: ['public', 'organizations'] });
      try {
        const attacker = 'https://attacker.example';
        const org = (
          await stack.pool.query<{ id: string }>(
            `insert into identity.organization (id, name, slug, created_at) values (uuidv7(), 'evil', 'evil', now()) returning id`,
          )
        ).rows[0]!.id;
        const owner = (
          await stack.pool.query<{ id: string }>(
            `insert into identity."user" (id, name, email, email_verified, created_at, updated_at) values (uuidv7(), 'o', 'o@evil.test', true, now(), now()) returning id`,
          )
        ).rows[0]!.id;
        await stack.pool.query(
          `insert into identity.sso_provider (id, issuer, oidc_config, user_id, provider_id, organization_id, domain, domain_verified)
           values (uuidv7(), $1, $2, $3::uuid, 'evil', $4::uuid, 'evil.test', false)`,
          [
            `${attacker}/oidc`,
            JSON.stringify({
              clientId: 'c',
              clientSecret: 's',
              discoveryEndpoint: `${attacker}/.well-known/openid-configuration`,
            }),
            owner,
            org,
          ],
        );
        const victim = uniqueEmail('victim');
        await verifiedUser(stack, victim, strongPassword(), expect);
        const reset = await stack.client().post(`${API}/request-password-reset`, {
          email: victim,
          redirectTo: `${attacker}/steal`,
        });
        expect(reset.status).toBe(403);
        const verify = await stack.client().post(`${API}/sign-up/email`, {
          email: uniqueEmail('x'),
          password: strongPassword(),
          name: 'x',
          callbackURL: `${attacker}/x`,
        });
        expect(verify.status).toBe(403);
      } finally {
        await stack.stop();
      }
    });

    it('creating an organization is closed by default and opens only with the product option', async () => {
      const closed = await startStack(infra, { presets: ['public', 'organizations'] });
      try {
        const user = await verifiedUser(closed, uniqueEmail('stranger'), strongPassword(), expect);
        const res = await user.post(`${API}/organization/create`, {
          name: 'Mine',
          slug: `mine-${randomUUID().slice(0, 6)}`,
        });
        expect(res.status).toBe(403);
      } finally {
        await closed.stop();
      }
      const open = await startStack(infra, {
        presets: ['public', 'organizations'],
        allowOrganizationCreation: true,
      });
      try {
        const user = await verifiedUser(open, uniqueEmail('stranger'), strongPassword(), expect);
        const res = await user.post(`${API}/organization/create`, {
          name: 'Mine',
          slug: `mine-${randomUUID().slice(0, 6)}`,
        });
        expect(res.status).toBe(200);
      } finally {
        await open.stop();
      }
    });
  });

  describe('review S2: the 12 h staff cap is enforced where sessions are written', () => {
    let stack: Stack;
    let idp: MockIdp;
    t.beforeAll(async () => {
      idp = await startMockIdp();
      stack = await startStack(infra, {
        presets: ['public', 'staff'],
        staff: { authority: idp.base },
      });
    });
    t.afterAll(async () => {
      await stack?.stop();
      await idp?.stop();
    });

    const lifetime = async (email: string) => {
      const { rows } = await stack.pool.query<{ secs: number }>(
        `select extract(epoch from (s.expires_at - s.created_at))::int as secs
           from identity.session s join identity."user" u on u.id = s.user_id where u.email = $1`,
        [email],
      );
      return rows[0]!.secs;
    };
    const ageSessions = async (email: string, hours: number) => {
      await stack.pool.query(
        `update identity.session s set created_at = s.created_at - make_interval(hours => $2),
                updated_at = s.updated_at - make_interval(hours => $2), expires_at = s.expires_at - make_interval(hours => $2)
           from identity."user" u where u.id = s.user_id and u.email = $1`,
        [email, hours],
      );
      await stack.flushCache();
    };
    const staffByDomainOnly = async () => {
      const email = `clerk-${randomUUID().slice(0, 6)}@${STAFF_DOMAIN}`;
      const password = strongPassword();
      const u = await stack.pool.query<{ id: string }>(
        `insert into identity."user" (id, name, email, email_verified, created_at, updated_at) values (uuidv7(), 'C', $1, true, now(), now()) returning id`,
        [email],
      );
      await stack.pool.query(
        `insert into identity.account (id, account_id, provider_id, user_id, password, created_at, updated_at)
         values (uuidv7(), $1::text, 'credential', $2::uuid, $3, now(), now())`,
        [
          u.rows[0]!.id,
          u.rows[0]!.id,
          await argon2hash(password, {
            memoryCost: 19456,
            timeCost: 2,
            parallelism: 1,
            algorithm: 2,
          }),
        ],
      );
      const c = stack.client();
      expect((await signIn(c, email, password)).status).toBe(200);
      return { email, c };
    };

    it('a tenant member signed in with Microsoft gets a 12 h session in a combined instance', async () => {
      const email = `lead-${randomUUID().slice(0, 6)}@${STAFF_DOMAIN}`;
      await microsoftSignIn(stack, idp, {
        sub: 'a',
        oid: randomUUID(),
        tid: TEST_TENANT,
        email,
        name: 'L',
      });
      expect(Math.abs((await lifetime(email)) - 12 * 3600)).toBeLessThanOrEqual(5);
    });

    it('a user with a staff-domain email but no Microsoft account is capped too; a public user is not', async () => {
      const { email } = await staffByDomainOnly();
      expect(Math.abs((await lifetime(email)) - 12 * 3600)).toBeLessThanOrEqual(5);
      const visitor = uniqueEmail('visitor');
      await verifiedUser(stack, visitor, strongPassword(), expect);
      expect(await lifetime(visitor)).toBeGreaterThan(6 * 86400);
    });

    it("a 13 h staff session is dead on get-session, list-sessions and update-user (Better Auth's own endpoints)", async () => {
      const { email, c } = await staffByDomainOnly();
      expect((await c.get(`${API}/list-sessions`)).status).toBe(200);
      await ageSessions(email, 13);
      expect((await c.get(`${API}/get-session?disableCookieCache=true`)).json()).toBeNull();
      expect((await c.get(`${API}/list-sessions`)).status).toBe(401);
      expect((await c.post(`${API}/update-user`, { name: 'Renamed' })).status).toBe(401);
    });

    it('a refresh cannot stretch a staff session beyond createdAt + 12 h', async () => {
      const { email, c } = await staffByDomainOnly();
      await ageSessions(email, 11); // one hour left
      expect((await c.get(`${API}/get-session?disableCookieCache=true`)).json()).not.toBeNull();
      const { rows } = await stack.pool.query<{ over: number }>(
        `select extract(epoch from (s.expires_at - s.created_at))::int - 43200 as over
           from identity.session s join identity."user" u on u.id = s.user_id where u.email = $1`,
        [email],
      );
      expect(rows[0]!.over).toBeLessThanOrEqual(5);
    });

    describe('N1: a staff session at its cap is not rewritten on every read', () => {
      const sessionToken = (c: { cookies: Record<string, string> }) =>
        decodeURIComponent(
          Object.entries(c.cookies).find(([name]) => name.endsWith('session_token'))![1],
        ).split('.')[0]!;
      /** Count UPDATEs of identity.session from here on (the trigger lives for the stack's lifetime). */
      const countWrites = async () => {
        await stack.pool.query(`
          create table if not exists session_writes (n serial);
          create or replace function session_writes_f() returns trigger language plpgsql as $$
            begin insert into session_writes default values; return null; end $$;
          drop trigger if exists session_writes_t on identity.session;
          create trigger session_writes_t after update on identity.session
            for each row execute function session_writes_f();`);
        const read = async () =>
          Number(
            (await stack.pool.query(`select count(*)::int as n from session_writes`)).rows[0].n,
          );
        return read;
      };
      /** Age ONE session in Postgres and in Valkey, as time passing would. */
      const age = async (c: { cookies: Record<string, string> }, hours: number) => {
        const token = sessionToken(c);
        await stack.pool.query(
          `update identity.session set created_at = created_at - make_interval(hours => $2),
                  updated_at = updated_at - make_interval(hours => $2),
                  expires_at = expires_at - make_interval(hours => $2) where token = $1`,
          [token, hours],
        );
        const cached = await stack.get(token);
        if (cached) {
          const value = JSON.parse(cached);
          for (const field of ['createdAt', 'updatedAt', 'expiresAt']) {
            value.session[field] = new Date(
              new Date(value.session[field]).getTime() - hours * 3600_000,
            ).toISOString();
          }
          await stack.seedCounter(token, JSON.stringify(value), 6 * 86400);
        }
      };
      const read10 = async (c: ReturnType<Stack['client']>) => {
        let cookies = 0;
        for (let i = 0; i < 10; i += 1) {
          const res = await c.get(`${API}/get-session?disableCookieCache=true`);
          expect(res.json()).not.toBeNull();
          if (res.setCookie.some((line) => /session_token=/.test(line))) cookies += 1;
        }
        return cookies;
      };

      it('a clamped session read 10 times: 0 database writes, 0 cache writes, no Set-Cookie at all', async () => {
        const { email, c } = await staffByDomainOnly();
        const writes = await countWrites();
        await age(c, 2); // past the 1 h updateAge: Better Auth wants to refresh it on every read
        const token = sessionToken(c);
        const before = await writes();
        const cachedBefore = await stack.get(token);
        expect(cachedBefore).not.toBeNull();
        expect(await read10(c)).toBe(0);
        expect(await writes()).toBe(before);
        expect(await stack.get(token)).toBe(cachedBefore);
        expect(await lifetime(email)).toBeLessThanOrEqual(12 * 3600 + 5);
      });

      it('the cap still holds: a refresh still cannot stretch a session past createdAt + 12 h, and a session past it is dead', async () => {
        // A staff session whose stored expiry is beyond the cap (7 d) and which is due a refresh:
        // the guard must NOT wave it through; the clamp runs, once, and brings it back to the cap.
        const { email, c } = await staffByDomainOnly();
        const token = sessionToken(c);
        await stack.pool.query(
          `update identity.session set expires_at = created_at + interval '7 days' where token = $1`,
          [token],
        );
        await stack.flushCache();
        await age(c, 25);
        const writes = await countWrites();
        const before = await writes();
        const first = await c.get(`${API}/get-session?disableCookieCache=true`);
        expect(first.status).toBe(200);
        expect(await writes()).toBe(before + 1);
        expect(await lifetime(email)).toBeLessThanOrEqual(12 * 3600 + 5);
        // 25 h old, so over the 12 h cap: dead from here on, and nothing is written for it.
        expect((await c.get(`${API}/get-session?disableCookieCache=true`)).json()).toBeNull();
        expect(await writes()).toBe(before + 1);
      });

      it("the guard is for staff only: a non-staff session, even a short one, is left to Better Auth's refresh", async () => {
        const email = uniqueEmail('visitor');
        const password = strongPassword();
        await verifiedUser(stack, email, password, expect);
        const c = stack.client();
        expect((await signIn(c, email, password)).status).toBe(200);
        await stack.pool.query(
          `update identity.session set expires_at = created_at + interval '6 hours' where token = $1`,
          [sessionToken(c)],
        );
        await stack.flushCache();
        const writes = await countWrites();
        const before = await writes();
        expect((await c.get(`${API}/get-session?disableCookieCache=true`)).status).toBe(200);
        expect(await writes()).toBe(before + 1);
      });

      it('a public session keeps its sliding refresh: once when due, then quiet', async () => {
        const email = uniqueEmail('visitor');
        const password = strongPassword();
        await verifiedUser(stack, email, password, expect);
        const c = stack.client();
        expect((await signIn(c, email, password)).status).toBe(200);
        await age(c, 48);
        const writes = await countWrites();
        const before = await writes();
        expect(await read10(c)).toBe(1);
        expect(await writes()).toBe(before + 1);
      });
    });
  });

  describe('review N1 (staff-only instance): a Microsoft staff session at its cap is not rewritten either', () => {
    it('read 10 times after the 1 h updateAge: 0 database writes, no Set-Cookie', async () => {
      const idp = await startMockIdp();
      const stack = await startStack(infra, { presets: ['staff'], staff: { authority: idp.base } });
      try {
        const email = `lead-${randomUUID().slice(0, 6)}@${STAFF_DOMAIN}`;
        const { client: c } = await microsoftSignIn(stack, idp, {
          sub: 'n',
          oid: randomUUID(),
          tid: TEST_TENANT,
          email,
          name: 'L',
        });
        await stack.pool.query(`
          create table session_writes (n serial);
          create function session_writes_f() returns trigger language plpgsql as $$
            begin insert into session_writes default values; return null; end $$;
          create trigger session_writes_t after update on identity.session
            for each row execute function session_writes_f();`);
        await stack.pool.query(
          `update identity.session set created_at = created_at - interval '2 hours',
                  updated_at = updated_at - interval '2 hours', expires_at = expires_at - interval '2 hours'`,
        );
        await stack.flushCache();
        const writes = async () =>
          Number(
            (await stack.pool.query(`select count(*)::int as n from session_writes`)).rows[0].n,
          );
        const before = await writes();
        for (let i = 0; i < 10; i += 1) {
          const res = await c.get(`${API}/get-session`);
          expect(res.json()).not.toBeNull();
          expect(res.setCookie.some((line) => /session_token=/.test(line))).toBe(false);
        }
        expect(await writes()).toBe(before);
      } finally {
        await stack.stop();
        await idp.stop();
      }
    });
  });

  describe('review S3: an Entra identity never takes over an existing account by email', () => {
    let idp: MockIdp;
    t.beforeAll(async () => {
      idp = await startMockIdp();
    });
    t.afterAll(() => idp?.stop());

    const open = (staff: Record<string, unknown> = {}) =>
      startStack(infra, { presets: ['public', 'staff'], staff: { authority: idp.base, ...staff } });

    it('a tenant member whose email is NOT on a staff domain is refused and nothing is written', async () => {
      const stack = await open();
      try {
        const email = `alias-${randomUUID().slice(0, 6)}@elsewhere.example`;
        const { client, callback } = await microsoftSignIn(stack, idp, {
          sub: 'a',
          oid: randomUUID(),
          tid: TEST_TENANT,
          email,
        });
        expect(callback.location).toMatch(/error=unable_to_get_user_info/);
        expect((await client.get(`${API}/get-session`)).json()).toBeNull();
        expect(
          (await stack.pool.query(`select 1 from identity."user" where email = $1`, [email])).rows,
        ).toHaveLength(0);
      } finally {
        await stack.stop();
      }
    });

    it('a guest whose email belongs to an existing account is refused with ACCOUNT_LINK_REQUIRED, and nothing is linked', async () => {
      const stack = await open({ allowGuests: true });
      try {
        const victim = uniqueEmail('victim');
        await verifiedUser(stack, victim, strongPassword(), expect);
        const before = (await stack.pool.query(`select count(*)::int as n from identity.account`))
          .rows[0].n;
        const { client, callback } = await microsoftSignIn(stack, idp, {
          sub: 'g',
          oid: randomUUID(),
          tid: TEST_TENANT,
          email: victim,
          claims: { acct: 1 },
        });
        expect(callback.location).toMatch(/error=ACCOUNT_LINK_REQUIRED/);
        expect((await client.get(`${API}/get-session`)).json()).toBeNull();
        expect(
          (await stack.pool.query(`select count(*)::int as n from identity.account`)).rows[0].n,
        ).toBe(before);
        const linked = await stack.pool.query(
          `select 1 from identity.account a join identity."user" u on u.id = a.user_id where u.email = $1 and a.provider_id = 'microsoft'`,
          [victim],
        );
        expect(linked.rows).toHaveLength(0);
      } finally {
        await stack.stop();
      }
    });

    it('the squatting replacement does not run for a guest: the unverified account survives and the guest is refused', async () => {
      const stack = await open({ allowGuests: true });
      try {
        const email = uniqueEmail('squat');
        const squatter = await stack.pool.query<{ id: string }>(
          `insert into identity."user" (id, name, email, email_verified, created_at, updated_at) values (uuidv7(), 'S', $1, false, now(), now()) returning id`,
          [email],
        );
        const { callback } = await microsoftSignIn(stack, idp, {
          sub: 'g',
          oid: randomUUID(),
          tid: TEST_TENANT,
          email,
          claims: { acct: 1 },
        });
        expect(callback.location).toMatch(/error=ACCOUNT_LINK_REQUIRED/);
        expect(
          (
            await stack.pool.query(`select 1 from identity."user" where id = $1`, [
              squatter.rows[0]!.id,
            ])
          ).rows,
        ).toHaveLength(1);
        expect(stack.events.some((e) => e.name === 'account.unverified_replaced')).toBe(false);
      } finally {
        await stack.stop();
      }
    });

    it('a new guest is created with an UNVERIFIED email and can come back with the same Entra identity', async () => {
      const stack = await open({ allowGuests: true });
      try {
        const email = `vendor-${randomUUID().slice(0, 6)}@vendor.example`;
        const oid = randomUUID();
        const guest = { sub: 'g', oid, tid: TEST_TENANT, email, claims: { acct: 1 } };
        const first = await microsoftSignIn(stack, idp, guest);
        expect((await first.client.get(`${API}/get-session`)).json()).not.toBeNull();
        const { rows } = await stack.pool.query<{ email_verified: boolean }>(
          `select email_verified from identity."user" where email = $1`,
          [email],
        );
        expect(rows[0]!.email_verified).toBe(false);
        const again = await microsoftSignIn(stack, idp, guest);
        expect((await again.client.get(`${API}/get-session`)).json()).not.toBeNull();
      } finally {
        await stack.stop();
      }
    });
  });

  describe('review S4 + A13: Google mirrors the company-domain rule and the squatting rule', () => {
    let stack: Stack;
    let idp: MockIdp;
    t.beforeAll(async () => {
      idp = await startMockIdp();
      stack = await startStack(infra, {
        presets: ['public', 'staff', 'organizations'],
        google: { clientId: 'google-client', clientSecret: `g-${randomUUID()}` },
        staff: { authority: idp.base },
        extraTrustedOrigins: [idp.base],
      });
    });
    t.afterAll(async () => {
      await stack?.stop();
      await idp?.stop();
    });

    /** What Google's callback hands `getUserInfo`: an id_token (its signature is checked earlier, by Better Auth). */
    const googleUser = (email: string, verified = true) => {
      const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const idToken = `${b64({ alg: 'none' })}.${b64({ sub: randomUUID(), email, email_verified: verified, name: 'G' })}.`;
      const provider = stack.auth.options.socialProviders?.google as unknown as {
        getUserInfo(token: {
          idToken: string;
        }): Promise<{ user: { email: string; emailVerified: boolean } } | null>;
      };
      return provider.getUserInfo({ idToken });
    };

    it('refuses an address on a staff domain', async () => {
      expect(await googleUser(`ceo@${STAFF_DOMAIN}`)).toBeNull();
      expect(await googleUser(`ceo@mail.${STAFF_DOMAIN}`)).toBeNull();
    });

    it('refuses an address on a VERIFIED SSO domain, but not on an unverified claim', async () => {
      await registerPartner(stack, idp, t, { domain: 'verified-g.test' });
      await registerPartner(stack, idp, t, { domain: 'claimed-g.test', verified: false });
      expect(await googleUser('a@verified-g.test')).toBeNull();
      expect((await googleUser('a@claimed-g.test'))?.user.email).toBe('a@claimed-g.test');
    });

    it('lets an ordinary verified address through, with the email marked verified', async () => {
      const info = await googleUser(`person-${randomUUID().slice(0, 6)}@gmail.example`);
      expect(info?.user.emailVerified).toBe(true);
    });

    it('replaces an unverified, never-used password account for an address Google reports verified', async () => {
      const email = uniqueEmail('squat');
      const squatter = await stack.pool.query<{ id: string }>(
        `insert into identity."user" (id, name, email, email_verified, created_at, updated_at) values (uuidv7(), 'S', $1, false, now(), now()) returning id`,
        [email],
      );
      await googleUser(email);
      expect(
        (
          await stack.pool.query(`select 1 from identity."user" where id = $1`, [
            squatter.rows[0]!.id,
          ])
        ).rows,
      ).toHaveLength(0);
      expect(
        stack.events.some(
          (e) => e.name === 'account.unverified_replaced' && e.userId === squatter.rows[0]!.id,
        ),
      ).toBe(true);
    });

    it('does not replace an account Google reports as UNVERIFIED, nor one that has a session', async () => {
      const unverified = uniqueEmail('unv');
      const a = await stack.pool.query<{ id: string }>(
        `insert into identity."user" (id, name, email, email_verified, created_at, updated_at) values (uuidv7(), 'A', $1, false, now(), now()) returning id`,
        [unverified],
      );
      await googleUser(unverified, false);
      expect(
        (await stack.pool.query(`select 1 from identity."user" where id = $1`, [a.rows[0]!.id]))
          .rows,
      ).toHaveLength(1);

      const used = uniqueEmail('used');
      const b = await stack.pool.query<{ id: string }>(
        `insert into identity."user" (id, name, email, email_verified, created_at, updated_at) values (uuidv7(), 'B', $1, false, now(), now()) returning id`,
        [used],
      );
      await stack.pool.query(
        `insert into identity.session (id, token, user_id, expires_at, created_at, updated_at) values (uuidv7(), $1, $2::uuid, now() + interval '1 day', now(), now())`,
        [randomUUID(), b.rows[0]!.id],
      );
      await googleUser(used);
      expect(
        (await stack.pool.query(`select 1 from identity."user" where id = $1`, [b.rows[0]!.id]))
          .rows,
      ).toHaveLength(1);
    });

    it('password sign-up for a company domain is refused (the rule Google mirrors)', async () => {
      const res = await stack.client().post(`${API}/sign-up/email`, {
        email: `x@${STAFF_DOMAIN}`,
        password: strongPassword(),
        name: 'x',
      });
      expect(res.status).toBe(403);
    });
  });

  describe('review S6 + A12: SSRF classifier, update-provider, redirects, no SAML', () => {
    const reg = (organizationId: string, base: string, extra: Record<string, unknown> = {}) => ({
      providerId: `p-${randomUUID().slice(0, 8)}`,
      issuer: `${base}/oidc`,
      domain: 'ssrf.test',
      organizationId,
      oidcConfig: {
        clientId: 'c',
        clientSecret: `s-${randomUUID()}`,
        discoveryEndpoint: `${base}/.well-known/openid-configuration`,
        pkce: true,
        mapping: { email: 'email', emailVerified: 'email_verified', name: 'name' },
      },
      ...extra,
    });

    it('refuses what a hand-written classifier misses: mapped IPv6, NAT64, 6to4, benchmarking, with a generic message', async () => {
      const strict = await startStack(infra, {
        presets: ['public', 'organizations'],
        unsafeTestNetwork: false,
      });
      try {
        const { organizationId, owner } = await createOrganization(strict, t);
        for (const base of [
          'https://[::ffff:7f00:1]',
          'https://[64:ff9b::7f00:1]',
          'https://[2002:7f00:1::1]',
          'https://198.18.0.1',
          'https://198.19.255.254',
          'https://100.64.0.1',
          'https://metadata.google.internal',
        ]) {
          const res = await owner.post(`${API}/sso/register`, reg(organizationId, base));
          expect(res.status, base).toBe(400);
          expect(res.json(), base).toEqual({
            code: 'SSO_URL_NOT_ALLOWED',
            message: 'That URL is not allowed for SSO.',
          });
        }
      } finally {
        await strict.stop();
      }
    });

    it('applies the same guard to /sso/update-provider: a verified provider cannot be re-pointed inward', async () => {
      const strict = await startStack(infra, {
        presets: ['public', 'staff', 'organizations'],
        unsafeTestNetwork: false,
      });
      try {
        const { organizationId, owner, ownerId } = await createOrganization(strict, t);
        await strict.pool.query(
          `insert into identity.sso_provider (id, issuer, oidc_config, user_id, provider_id, organization_id, domain, domain_verified)
           values (uuidv7(), 'https://idp.partner.example/oidc', $1, $2::uuid, 'inward', $3::uuid, 'partner.example', true)`,
          [
            JSON.stringify({
              clientId: 'c',
              clientSecret: 's',
              discoveryEndpoint: 'https://idp.partner.example/.well-known/openid-configuration',
            }),
            ownerId,
            organizationId,
          ],
        );
        for (const tokenEndpoint of [
          'https://10.0.0.5/token',
          'https://[::ffff:7f00:1]/token',
          'http://idp.partner.example/token',
        ]) {
          const res = await owner.post(`${API}/sso/update-provider`, {
            providerId: 'inward',
            oidcConfig: { tokenEndpoint },
          });
          expect(res.status, tokenEndpoint).toBe(400);
          expect(res.json(), tokenEndpoint).toMatchObject({ code: 'SSO_URL_NOT_ALLOWED' });
        }
        const reserved = await owner.post(`${API}/sso/update-provider`, {
          providerId: 'inward',
          domain: STAFF_DOMAIN,
        });
        expect(reserved.status).toBe(403);
        expect(reserved.json()).toMatchObject({ code: 'SSO_DOMAIN_RESERVED' });
      } finally {
        await strict.stop();
      }
    });

    it('refuses a URL that redirects (to a private address)', async () => {
      const redirecting = createServer((_req, res) => {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' });
        res.end();
      });
      await new Promise<void>((resolve) => redirecting.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${(redirecting.address() as { port: number }).port}`;
      const stack = await startStack(infra, {
        presets: ['public', 'organizations'],
        extraTrustedOrigins: [base],
      });
      try {
        const { organizationId, owner } = await createOrganization(stack, t);
        const res = await owner.post(`${API}/sso/register`, reg(organizationId, base));
        expect(res.status).toBe(400);
        expect(res.json()).toMatchObject({ code: 'SSO_URL_NOT_ALLOWED' });
      } finally {
        await stack.stop();
        await new Promise<void>((resolve) => redirecting.close(() => resolve()));
      }
    });

    it('D18: SAML is not in 8.0.0 — samlConfig is refused and the SAML routes answer 404', async () => {
      const stack = await startStack(infra, { presets: ['public', 'organizations'] });
      try {
        const { organizationId, owner } = await createOrganization(stack, t);
        const withSaml = await owner.post(
          `${API}/sso/register`,
          reg(organizationId, 'https://idp.partner.example', {
            samlConfig: {
              entryPoint: 'https://idp.partner.example/sso',
              cert: 'x',
              callbackUrl: '/x',
              spMetadata: {},
            },
          }),
        );
        expect(withSaml.status).toBe(400);
        expect(withSaml.json()).toMatchObject({ code: 'SAML_NOT_SUPPORTED' });
        for (const path of [
          '/sso/saml2/sp/metadata?providerId=x',
          '/sso/saml2/callback/x',
          '/sso/saml2/sp/acs/x',
        ]) {
          const res = await owner.get(`${API}${path}`);
          expect(res.status, path).toBe(404);
        }
      } finally {
        await stack.stop();
      }
    });
  });

  describe('review S7 + S8 + S9: test-login allow-list, no impersonation, no secret echo', () => {
    it('S7: test-login loads only for NODE_ENV exactly "test" or "development" (with both switches)', async () => {
      for (const NODE_ENV of ['production', 'staging', 'prod', '', undefined]) {
        await expect(
          startStack(infra, {
            testLogin: true,
            unsafeTestNetwork: false,
            env: { IDENTITY_TEST_LOGIN: 'enabled', NODE_ENV },
          }),
        ).rejects.toThrow(/test-login refused/);
      }
      const ok = await startStack(infra, {
        testLogin: true,
        env: { IDENTITY_TEST_LOGIN: 'enabled', NODE_ENV: 'test' },
      });
      try {
        const c = ok.client();
        expect((await c.post(`${API}/test-login`, { email: uniqueEmail('e2e') })).status).toBe(200);
      } finally {
        await ok.stop();
      }
    });

    it('S8: admin impersonation does not exist in 8.0.0', async () => {
      const stack = await startStack(infra, { presets: ['public'] });
      try {
        const adminEmail = uniqueEmail('admin');
        const password = strongPassword();
        await verifiedUser(stack, adminEmail, password, expect);
        await stack.pool.query(`update identity."user" set role = 'admin' where email = $1`, [
          adminEmail,
        ]);
        const victim = uniqueEmail('victim');
        await verifiedUser(stack, victim, strongPassword(), expect);
        const victimId = (
          await stack.pool.query<{ id: string }>(
            `select id from identity."user" where email = $1`,
            [victim],
          )
        ).rows[0]!.id;
        const admin = stack.client();
        expect((await signIn(admin, adminEmail, password)).status).toBe(200);
        expect(
          (await admin.post(`${API}/admin/impersonate-user`, { userId: victimId })).status,
        ).toBe(404);
        expect((await admin.post(`${API}/admin/stop-impersonating`, {})).status).toBe(404);
        // the rest of the admin plugin still works
        expect(
          (await admin.post(`${API}/admin/revoke-user-sessions`, { userId: victimId })).status,
        ).toBe(200);
        expect(stack.events.some((e) => e.name === ('admin.impersonation_started' as never))).toBe(
          false,
        );
        for (const path of ['/admin/impersonate-user', '/admin/stop-impersonating']) {
          expect(stack.auth.options.disabledPaths).toContain(path);
        }
      } finally {
        await stack.stop();
      }
    });

    it('S9: /sso/register never echoes the client secret (asserted for every registration in the kit)', async () => {
      const idp = await startMockIdp();
      const stack = await startStack(infra, {
        presets: ['public', 'organizations'],
        extraTrustedOrigins: [idp.base],
      });
      try {
        const partner = await registerPartner(stack, idp, t, { domain: 'quiet2-u.test' });
        const list = await partner.owner.get(`${API}/sso/providers`);
        expect(list.body.includes(partner.clientSecret)).toBe(false);
        const update = await partner.owner.post(`${API}/sso/update-provider`, {
          providerId: partner.providerId,
          oidcConfig: { scopes: ['openid', 'email'] },
        });
        expect(update.body.includes(partner.clientSecret)).toBe(false);
      } finally {
        await stack.stop();
        await idp.stop();
      }
    });
  });

  describe('review A13: behaviours the first kit did not pin', () => {
    it('Valkey outage: users can still sign up, verify and sign in, quickly, and the limiters fail open', async () => {
      const degraded: string[] = [];
      const stack = await startStack(infra, {
        appValkeyUrl: 'redis://127.0.0.1:1', // nothing listens there
        onStorageDegraded: (operation) => degraded.push(operation),
      });
      try {
        const started = performance.now();
        const email = uniqueEmail('outage');
        const password = strongPassword();
        const c = await verifiedUser(stack, email, password, expect);
        expect((await c.get(`${API}/get-session`)).json()).not.toBeNull(); // sessions fall back to Postgres
        // The built-in per-IP rule (3 sign-ins / 10 s) lives in Valkey, so it is OFF too: fail open.
        const ip = '203.0.113.99';
        for (let i = 0; i < 6; i += 1) {
          expect(
            (await signIn(stack.client({ ip }), uniqueEmail('open'), strongPassword())).status,
          ).toBe(401);
        }
        expect(performance.now() - started).toBeLessThan(10_000); // measured 67 ms; 39 s without the short-circuit
        expect(degraded.length).toBeGreaterThan(0);
      } finally {
        await stack.stop();
      }
    });

    it('sendOnSignIn: a correct password on an unverified account re-sends the verification mail (the 403 stays)', async () => {
      const stack = await startStack(infra);
      try {
        const email = uniqueEmail('resend');
        const password = strongPassword();
        const c = stack.client();
        await c.post(`${API}/sign-up/email`, { email, password, name: 'x' });
        const count = async () => (await stack.mail()).filter((m) => m.to === email).length;
        expect(await count()).toBe(1);
        // the verification token is stamped in whole seconds; a resend in the same second is the same mail
        await new Promise((r) => setTimeout(r, 1100));
        const wrong = await signIn(stack.client(), email, strongPassword());
        expect(wrong.status).toBe(401);
        expect(await count()).toBe(1); // a wrong password sends nothing: only the owner can trigger it
        const right = await signIn(stack.client(), email, password);
        expect(right.status).toBe(403);
        expect(right.json()).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
        expect(await count()).toBe(2);
      } finally {
        await stack.stop();
      }
    });

    it('sign-up is limited per IP (3 per 10 s) and not by anything else', async () => {
      const stack = await startStack(infra);
      try {
        const ip = '203.0.113.120';
        const codes: number[] = [];
        for (let i = 0; i < 5; i += 1) {
          codes.push(
            (
              await stack.client({ ip }).post(`${API}/sign-up/email`, {
                email: uniqueEmail('burst'),
                password: strongPassword(),
                name: 'x',
              })
            ).status,
          );
        }
        expect(codes).toEqual([200, 200, 200, 429, 429]);
        const other = await stack.client({ ip: '203.0.113.121' }).post(`${API}/sign-up/email`, {
          email: uniqueEmail('other'),
          password: strongPassword(),
          name: 'x',
        });
        expect(other.status).toBe(200);
      } finally {
        await stack.stop();
      }
    });
  });

  describe('review A14: logs and security events reach the product, social and SSO sign-ins included', () => {
    let idp: MockIdp;
    let stack: Stack;
    t.beforeAll(async () => {
      idp = await startMockIdp();
      stack = await startStack(infra, {
        presets: ['public', 'staff', 'organizations'],
        staff: { authority: idp.base },
        extraTrustedOrigins: [idp.base],
      });
    });
    t.afterAll(async () => {
      await stack?.stop();
      await idp?.stop();
    });

    it("Better Auth's warnings go to the injected logger, and never carry the password", async () => {
      const password = strongPassword();
      await signIn(stack.client(), uniqueEmail('nobody'), password);
      expect(stack.logs.length).toBeGreaterThan(0);
      expect(stack.logs.every((l) => l.level === 'warn' || l.level === 'error')).toBe(true);
      expect(stack.logs.some((l) => l.message.includes(password))).toBe(false);
    });

    it('email sign-in, lockout, reset and revocation emit events with ids only', async () => {
      const email = uniqueEmail('events');
      const c = await verifiedUser(stack, email, strongPassword(), expect);
      await signIn(stack.client(), email, strongPassword());
      await c.post(`${API}/revoke-sessions`, {});
      const names = new Set(stack.events.map((e) => e.name));
      for (const name of ['sign_in.success', 'sign_in.failure', 'sessions.revoked'] as const) {
        expect(names.has(name), name).toBe(true);
      }
      expect(JSON.stringify(stack.events).includes(email)).toBe(false);
    });

    it('a Microsoft sign-in emits sign_in.success; a refused one emits sign_in.failure (method social)', async () => {
      const before = stack.events.length;
      await microsoftSignIn(stack, idp, {
        sub: 'm',
        oid: randomUUID(),
        tid: TEST_TENANT,
        email: `ok-${randomUUID().slice(0, 6)}@${STAFF_DOMAIN}`,
      });
      await microsoftSignIn(stack, idp, {
        sub: 'x',
        oid: randomUUID(),
        tid: '99999999-9999-4999-8999-999999999999',
        email: `no-${randomUUID().slice(0, 6)}@${STAFF_DOMAIN}`,
      });
      const fresh = stack.events.slice(before).filter((e) => e.detail?.['method'] === 'social');
      expect(fresh.map((e) => e.name)).toEqual(['sign_in.success', 'sign_in.failure']);
    });

    it('an SSO sign-in emits sign_in.success; one refused for its domain emits sign_in.failure (method sso)', async () => {
      await registerPartner(stack, idp, t, { domain: 'events-u.test' });
      const before = stack.events.length;
      idp.loginAs({ sub: 'e1', email: 'ann@events-u.test', name: 'Ann' });
      await ssoSignIn(stack.client(), { email: 'ann@events-u.test' });
      idp.loginAs({ sub: 'e2', email: 'eve@elsewhere.example', name: 'Eve' });
      await ssoSignIn(stack.client(), { email: 'x@events-u.test' });
      const fresh = stack.events.slice(before).filter((e) => e.detail?.['method'] === 'sso');
      expect(fresh.map((e) => e.name)).toEqual(['sign_in.success', 'sign_in.failure']);
    });
  });

  describe('review S5b: a known-device cookie is bound to the credential and expires server-side', () => {
    let stack: Stack;
    t.beforeAll(async () => {
      stack = await startStack(infra);
    });
    t.afterAll(() => stack?.stop());

    const generation = async (subject: string) =>
      Number(await stack.get(lockoutKeys.gen(subject))) || 0;
    const floodCeiling = async (email: string) =>
      stack.seedCounter(
        lockoutKeys.account('signin', await generation(email), email),
        DEFAULTS.lockout.perAccount.ceiling,
        3600,
      );
    /** Sign in on a fresh browser: each one is handed its own known-device cookie. */
    const mint = async (email: string, password: string) => {
      const c = stack.client();
      expect((await signIn(c, email, password)).status).toBe(200);
      const entry = Object.entries(c.cookies).find(([name]) => name.endsWith('.known_device'));
      expect(entry, 'a successful sign-in mints a cookie').toBeDefined();
      return { client: c, name: entry![0], value: entry![1] };
    };
    /**
     * Does this cookie still bypass the account-wide ceiling? The ceiling is exhausted first, so the
     * RIGHT password is refused (429) unless the cookie is honoured (200).
     */
    const bypasses = async (
      email: string,
      password: string,
      cookie: { name: string; value: string },
    ) => {
      await floodCeiling(email);
      const browser = stack.client({ ip: `198.51.100.${100 + Math.floor(Math.random() * 100)}` });
      browser.setCookies({ [cookie.name]: cookie.value });
      return (await signIn(browser, email, password)).status === 200;
    };
    const newUser = async () => {
      const email = uniqueEmail('bind');
      const password = strongPassword();
      await verifiedUser(stack, email, password, expect);
      return { email, password };
    };

    it('control: a fresh cookie bypasses the exhausted ceiling', async () => {
      const { email, password } = await newUser();
      expect(await bypasses(email, password, await mint(email, password))).toBe(true);
    });

    it('an old cookie gets no bypass after change-password', async () => {
      const { email, password } = await newUser();
      const old = await Promise.all([
        mint(email, password),
        mint(email, password),
        mint(email, password),
      ]);
      const owner = stack.client();
      await signIn(owner, email, password);
      const next = strongPassword();
      const changed = await owner.post(`${API}/change-password`, {
        currentPassword: password,
        newPassword: next,
        revokeOtherSessions: true,
      });
      expect(changed.status, changed.body).toBe(200);
      const fresh = await mint(email, next); // minted AFTER the change, before the ceiling is exhausted
      for (const cookie of old) expect(await bypasses(email, next, cookie)).toBe(false);
      expect(await bypasses(email, next, fresh)).toBe(true);
    });

    it('an old cookie gets no bypass after a password reset', async () => {
      const { email, password } = await newUser();
      const old = await mint(email, password);
      await stack.client().post(`${API}/request-password-reset`, { email, redirectTo: '/r' });
      const mail = (await stack.mail()).filter(
        (m) => m.to === email && m.category === 'auth.reset-password',
      );
      const token = new URL(mail.at(-1)!.text).pathname.split('/').pop()!;
      const next = strongPassword();
      expect(
        (await stack.client().post(`${API}/reset-password`, { token, newPassword: next })).status,
      ).toBe(200);
      expect(await bypasses(email, next, old)).toBe(false);
    });

    it('an old cookie gets no bypass after "sign out everywhere" or the admin\'s revoke-all', async () => {
      const own = await newUser();
      const ownCookie = await mint(own.email, own.password);
      const session = stack.client();
      await signIn(session, own.email, own.password);
      expect((await session.post(`${API}/revoke-sessions`, {})).status).toBe(200);
      expect(await bypasses(own.email, own.password, ownCookie)).toBe(false);

      const target = await newUser();
      const targetCookie = await mint(target.email, target.password);
      const adminEmail = uniqueEmail('admin');
      const adminPassword = strongPassword();
      await verifiedUser(stack, adminEmail, adminPassword, expect);
      await stack.pool.query(`update identity."user" set role = 'admin' where email = $1`, [
        adminEmail,
      ]);
      const admin = stack.client();
      await signIn(admin, adminEmail, adminPassword);
      const targetId = (
        await stack.pool.query<{ id: string }>(`select id from identity."user" where email = $1`, [
          target.email,
        ])
      ).rows[0]!.id;
      expect(
        (await admin.post(`${API}/admin/revoke-user-sessions`, { userId: targetId })).status,
      ).toBe(200);
      expect(await bypasses(target.email, target.password, targetCookie)).toBe(false);
    });

    it('a cookie older than the server-side maximum gets no bypass, whatever the browser kept', async () => {
      const { email, password } = await newUser();
      const real = await mint(email, password);
      const secret = stack.env[DEFAULTS.secretEnv]!;
      const [, userId, deviceId, , epoch] = real.value.split('.') as [
        string,
        string,
        string,
        string,
        string,
      ];
      const reissue = (iat: number, name = real.name) =>
        signDeviceValue(secret, name, ['v2', userId, deviceId, iat, epoch].join('.'));
      const now = Math.floor(Date.now() / 1000);
      const max = DEFAULTS.lockout.knownDevice.maxAgeSeconds;
      // the forgery is sound: a value signed with the same iat as the real one still bypasses
      expect(await bypasses(email, password, { name: real.name, value: reissue(now - 60) })).toBe(
        true,
      );
      expect(
        await bypasses(email, password, { name: real.name, value: reissue(now - max - 10) }),
      ).toBe(false);
      expect(await bypasses(email, password, { name: real.name, value: reissue(now + 3600) })).toBe(
        false,
      );
    });

    it('domain separation: a value tagged for another cookie name, or an old-format cookie, is no cookie', async () => {
      const { email, password } = await newUser();
      const real = await mint(email, password);
      const secret = stack.env[DEFAULTS.secretEnv]!;
      const payload = real.value.slice(0, real.value.lastIndexOf('.'));
      const foreign = signDeviceValue(secret, '__Secure-conformance.session_data', payload);
      expect(await bypasses(email, password, { name: real.name, value: foreign })).toBe(false);
      const userId = payload.split('.')[1]!;
      expect(
        await bypasses(email, password, {
          name: real.name,
          value: `${userId}:${'a'.repeat(24)}.c2ln`,
        }),
      ).toBe(false);
    });

    it('all valid devices together are capped: 20 failures an hour, then cookies count for nothing', async () => {
      const { email, password } = await newUser();
      const cookies = await Promise.all(Array.from({ length: 5 }, () => mint(email, password)));
      await floodCeiling(email); // so a request judged "no cookie" is refused
      const attempt = async (cookie: { name: string; value: string }, n: number) => {
        const browser = stack.client({ ip: `198.51.100.${n + 1}` });
        browser.setCookies({ [cookie.name]: cookie.value });
        return (await signIn(browser, email, strongPassword())).status;
      };
      const { maxAttempts, accountMaxAttempts } = DEFAULTS.lockout.knownDevice;
      let n = 0;
      for (const cookie of cookies.slice(0, 4)) {
        for (let i = 0; i < maxAttempts; i += 1) expect(await attempt(cookie, n++)).toBe(401);
      }
      expect(n).toBe(accountMaxAttempts);
      // a fifth device, a first attempt: the account's device budget is spent, the ceiling decides
      expect(await attempt(cookies[4]!, n++)).toBe(429);
      expect(await attempt(cookies[0]!, n++)).toBe(429);
    }, 60_000);
  });

  describe('review L1 + L2 + I1: the device budget, server-side calls, "other sessions"', () => {
    let stack: Stack;
    t.beforeAll(async () => {
      stack = await startStack(infra);
    });
    t.afterAll(() => stack?.stop());

    const generation = async (subject: string) =>
      Number(await stack.get(lockoutKeys.gen(subject))) || 0;
    const floodCeiling = async (email: string) =>
      stack.seedCounter(
        lockoutKeys.account('signin', await generation(email), email),
        DEFAULTS.lockout.perAccount.ceiling,
        3600,
      );
    const mint = async (email: string, password: string) => {
      const c = stack.client();
      expect((await signIn(c, email, password)).status).toBe(200);
      const [name, value] = Object.entries(c.cookies).find(([n]) => n.endsWith('.known_device'))!;
      return { client: c, name, value };
    };
    const bypasses = async (
      email: string,
      password: string,
      cookie: { name: string; value: string },
    ) => {
      await floodCeiling(email);
      const browser = stack.client({ ip: `198.51.100.${100 + Math.floor(Math.random() * 100)}` });
      browser.setCookies({ [cookie.name]: cookie.value });
      return (await signIn(browser, email, password)).status === 200;
    };
    const newUser = async () => {
      const email = uniqueEmail('follow');
      const password = strongPassword();
      await verifiedUser(stack, email, password, expect);
      return { email, password };
    };

    it("L1: one stolen cookie cannot spend the account's shared budget; the owner's other device still gets in", async () => {
      const { email, password } = await newUser();
      const stolen = await mint(email, password);
      const other = await mint(email, password);
      await floodCeiling(email); // anything judged "no cookie" is refused, so only cookies can succeed
      const codes: number[] = [];
      for (let i = 0; i < 30; i += 1) {
        const thief = stack.client({ ip: `198.51.100.${i + 1}` });
        thief.setCookies({ [stolen.name]: stolen.value });
        codes.push((await signIn(thief, email, strongPassword())).status);
      }
      const { maxAttempts } = DEFAULTS.lockout.knownDevice;
      expect(codes.filter((c) => c === 401)).toHaveLength(maxAttempts);
      expect(codes.filter((c) => c === 429)).toHaveLength(30 - maxAttempts);
      // only the attempts that PASSED the device limit were charged to the shared budget
      expect(await stack.get(lockoutKeys.devices('signin', await generation(email), email))).toBe(
        String(maxAttempts),
      );
      const owner = stack.client({ ip: '198.51.100.250' });
      owner.setCookies({ [other.name]: other.value });
      expect((await signIn(owner, email, password)).status).toBe(200);
    }, 60_000);

    it('L2: a SERVER-SIDE auth.api.revokeSessions({ headers }) kills the remembered devices too', async () => {
      const { email, password } = await newUser();
      const old = await mint(email, password);
      const session = stack.client();
      await signIn(session, email, password);
      const headers = new Headers({
        cookie: Object.entries(session.cookies)
          .map(([k, v]) => `${k}=${v}`)
          .join('; '),
      });
      await stack.auth.api.revokeSessions({ headers });
      expect(await bypasses(email, password, old)).toBe(false);
    });

    it('L2: a SERVER-SIDE auth.api.resetPassword({ body }) clears the lockout counters', async () => {
      const { email, password } = await newUser();
      const ip = '203.0.113.77';
      await stack.seedCounter(
        lockoutKeys.accountAndIp('signin', await generation(email), email, ip),
        DEFAULTS.lockout.perAccountAndIp.maxAttempts,
      );
      expect((await signIn(stack.client({ ip }), email, password)).status).toBe(429);
      await stack.client().post(`${API}/request-password-reset`, { email, redirectTo: '/r' });
      const mail = (await stack.mail()).filter(
        (m) => m.to === email && m.category === 'auth.reset-password',
      );
      const token = new URL(mail.at(-1)!.text).pathname.split('/').pop()!;
      const next = strongPassword();
      await stack.auth.api.resetPassword({ body: { token, newPassword: next } });
      expect((await signIn(stack.client({ ip }), email, next)).status).toBe(200);
    });

    it('I1: "sign out other sessions" kills every OTHER device\'s cookie and re-issues the asking one with the new epoch', async () => {
      const { email, password } = await newUser();
      const here = await mint(email, password);
      const elsewhere = await mint(email, password);
      const third = await mint(email, password);
      const response = await here.client.post(`${API}/revoke-other-sessions`, {});
      expect(response.status, response.body).toBe(200);

      // this browser got a fresh cookie in the SAME response: same device, same iat, new epoch
      const reissued = response.setCookie.find((l) => /known_device=/.test(l));
      expect(reissued, "the response re-issues the asking device's cookie").toBeDefined();
      const now = here.client.cookies[here.name]!;
      const [, userId, deviceId, iat, epoch] = here.value.split('.');
      const [, userId2, deviceId2, iat2, epoch2] = now.split('.');
      expect([userId2, deviceId2, iat2]).toEqual([userId, deviceId, iat]);
      expect(epoch2).not.toBe(epoch);

      expect(await bypasses(email, password, { name: here.name, value: now })).toBe(true);
      expect(await bypasses(email, password, elsewhere)).toBe(false);
      expect(await bypasses(email, password, third)).toBe(false);
      // the pre-call value of the asking device is dead as well (it is the old epoch)
      expect(await bypasses(email, password, { name: here.name, value: here.value })).toBe(false);
    });

    it('I1: without a valid cookie nothing is minted by "sign out other sessions"', async () => {
      const { email, password } = await newUser();
      const plain = stack.client();
      await signIn(plain, email, password);
      const browser = stack.client();
      browser.setCookies(
        Object.fromEntries(
          Object.entries(plain.cookies).filter(([n]) => !n.endsWith('.known_device')),
        ),
      );
      const res = await browser.post(`${API}/revoke-other-sessions`, {});
      expect(res.status).toBe(200);
      expect(res.setCookie.some((l) => /known_device=/.test(l))).toBe(false);
    });
  });

  describe('review R1 + R2: the re-issue is validated, and it cannot race', () => {
    let stack: Stack;
    t.beforeAll(async () => {
      stack = await startStack(infra);
    });
    t.afterAll(() => stack?.stop());

    const generation = async (subject: string) =>
      Number(await stack.get(lockoutKeys.gen(subject))) || 0;
    const floodCeiling = async (email: string) =>
      stack.seedCounter(
        lockoutKeys.account('signin', await generation(email), email),
        DEFAULTS.lockout.perAccount.ceiling,
        3600,
      );
    const newUser = async () => {
      const email = uniqueEmail('reissue');
      const password = strongPassword();
      await verifiedUser(stack, email, password, expect);
      return { email, password };
    };
    /** A browser with a session AND a known-device cookie (one sign-in gives both). */
    const device = async (email: string, password: string) => {
      const client = stack.client();
      expect((await signIn(client, email, password)).status).toBe(200);
      const name = Object.keys(client.cookies).find((n) => n.endsWith('.known_device'))!;
      return { client, name, cookie: () => client.cookies[name]! };
    };
    const bypasses = async (
      email: string,
      password: string,
      cookie: { name: string; value: string },
    ) => {
      await floodCeiling(email);
      const browser = stack.client({ ip: `198.51.100.${100 + Math.floor(Math.random() * 100)}` });
      browser.setCookies({ [cookie.name]: cookie.value });
      return (await signIn(browser, email, password)).status === 200;
    };
    const mintsCookie = (res: { setCookie: string[] }) =>
      res.setCookie.some((l) => /known_device=/.test(l));

    describe('R1: nothing is re-issued unless the cookie asking is valid, for THIS user, now', () => {
      it("(a) X's session carrying Y's valid cookie: nothing minted, Y unaffected", async () => {
        const x = await newUser();
        const y = await newUser();
        const theirs = await device(y.email, y.password);
        const session = await device(x.email, x.password);
        session.client.setCookies({ ...session.client.cookies, [theirs.name]: theirs.cookie() });
        const res = await session.client.post(`${API}/revoke-other-sessions`, {});
        expect(res.status, res.body).toBe(200);
        expect(mintsCookie(res)).toBe(false);
        expect(
          await bypasses(y.email, y.password, { name: theirs.name, value: theirs.cookie() }),
        ).toBe(true);
      });

      it("(b) X's own stale-epoch cookie (the password changed since): nothing minted, Y unaffected", async () => {
        const x = await newUser();
        const y = await newUser();
        const stale = await device(x.email, x.password);
        const staleValue = stale.cookie();
        const changer = await device(x.email, x.password);
        const next = strongPassword();
        expect(
          (
            await changer.client.post(`${API}/change-password`, {
              currentPassword: x.password,
              newPassword: next,
            })
          ).status,
        ).toBe(200);
        const session = stack.client();
        expect((await signIn(session, x.email, next)).status).toBe(200);
        session.setCookies({ ...session.cookies, [stale.name]: staleValue });
        const res = await session.post(`${API}/revoke-other-sessions`, {});
        expect(res.status, res.body).toBe(200);
        expect(mintsCookie(res)).toBe(false);
        const other = await device(y.email, y.password);
        expect(
          await bypasses(y.email, y.password, { name: other.name, value: other.cookie() }),
        ).toBe(true);
      });

      it("(c) X's own cookie with an over-age iat: nothing minted, Y unaffected", async () => {
        const x = await newUser();
        const y = await newUser();
        const session = await device(x.email, x.password);
        const [, userId, deviceId, , epoch] = session.cookie().split('.') as [
          string,
          string,
          string,
          string,
          string,
        ];
        const old = Math.floor(Date.now() / 1000) - DEFAULTS.lockout.knownDevice.maxAgeSeconds - 10;
        const aged = signDeviceValue(
          stack.env[DEFAULTS.secretEnv]!,
          session.name,
          ['v2', userId, deviceId, old, epoch].join('.'),
        );
        session.client.setCookies({ ...session.client.cookies, [session.name]: aged });
        const res = await session.client.post(`${API}/revoke-other-sessions`, {});
        expect(res.status, res.body).toBe(200);
        expect(mintsCookie(res)).toBe(false);
        const other = await device(y.email, y.password);
        expect(
          await bypasses(y.email, y.password, { name: other.name, value: other.cookie() }),
        ).toBe(true);
      });
    });

    describe('R2: two things racing cannot both leave a cookie behind', () => {
      it('two devices calling "sign out other sessions" at once: at most one cookie survives', async () => {
        const outcomes: number[] = [];
        for (let trial = 0; trial < 8; trial += 1) {
          const { email, password } = await newUser();
          const a = await device(email, password);
          const b = await device(email, password);
          const [ra, rb] = await Promise.all([
            a.client.post(`${API}/revoke-other-sessions`, {}),
            b.client.post(`${API}/revoke-other-sessions`, {}),
          ]);
          expect([ra.status, rb.status].every((c) => c === 200 || c === 401)).toBe(true);
          let alive = 0;
          for (const d of [a, b]) {
            if (await bypasses(email, password, { name: d.name, value: d.cookie() })) alive += 1;
          }
          outcomes.push(alive);
        }
        expect(
          Math.max(...outcomes),
          `survivors per trial: ${outcomes.join(',')}`,
        ).toBeLessThanOrEqual(1);
      }, 120_000);

      it('"sign out other sessions" racing a password change: no cookie survives', async () => {
        // Deterministic interleaving: a trigger makes the DELETE of the other sessions take 600 ms, and
        // the password change lands inside that window, i.e. AFTER the revoke has taken its snapshot and
        // BEFORE it re-issues. (Without the CAS-and-snapshot design the re-issue re-read the epoch and
        // minted a cookie that was valid under the NEW password.)
        const { email, password } = await newUser();
        const a = await device(email, password);
        const b = await device(email, password);
        const changer = stack.client();
        expect((await signIn(changer, email, password)).status).toBe(200);
        const next = strongPassword();
        await stack.pool.query(`
          create or replace function identity.slow_delete() returns trigger language plpgsql as $$
          begin perform pg_sleep(0.6); return null; end $$;
          create trigger slow_delete after delete on identity.session
            for each statement execute function identity.slow_delete();`);
        try {
          const revoke = a.client.post(`${API}/revoke-other-sessions`, {});
          await new Promise((r) => setTimeout(r, 200));
          const changed = await changer.post(`${API}/change-password`, {
            currentPassword: password,
            newPassword: next,
          });
          expect(changed.status, changed.body).toBe(200);
          expect((await revoke).status).toBe(200);
        } finally {
          await stack.pool.query(`drop trigger if exists slow_delete on identity.session`);
        }
        for (const d of [a, b]) {
          expect(await bypasses(email, next, { name: d.name, value: d.cookie() })).toBe(false);
        }
      }, 60_000);
    });
  });
}

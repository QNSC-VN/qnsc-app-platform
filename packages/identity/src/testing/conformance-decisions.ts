import { randomUUID } from 'node:crypto';
import { purgeUnverifiedAccounts } from '../create-identity';
import { registerIdentityJobs } from '../jobs';
import { purgeUnverifiedAccounts as rootPurge } from '../index';
import { AUTH_MAIL_PRIORITY, MAIL_QUEUE } from '../ports';
import { DEFAULTS } from '../defaults';
import { mailIdempotencyKey } from '../mail-port';
import { verifiedUser } from './flows';
import {
  API,
  OTHER_TENANT,
  STAFF_DOMAIN,
  TEST_TENANT,
  startStack,
  strongPassword,
  uniqueEmail,
  type ConformanceInfra,
  type Stack,
} from './harness';
import { startMockIdp, type MockIdp } from './mock-idp';
import { createOrganization, registerPartner, ssoSignIn, type TestApi } from './support';

/** The decisions of ADR 0002 and identity plan §13 (D9–D20), one `describe` each. */
export function decisionsConformance(t: TestApi, infra: ConformanceInfra): void {
  const { describe, it, beforeAll, afterAll, expect } = t;

  const entra =
    (idp: MockIdp, identity: Parameters<MockIdp['loginAs']>[0], stack: Stack) => async () => {
      idp.loginAs(identity);
      const c = stack.client();
      const start = await c.post(`${API}/sign-in/social`, {
        provider: 'microsoft',
        callbackURL: '/',
      });
      const authz = await c.get(start.json<{ url: string }>().url);
      const callback = await c.get(authz.location!);
      return { c, callback };
    };

  describe('D9 SSO client secret is encrypted in the column', () => {
    let stack: Stack;
    let idp: MockIdp;
    beforeAll(async () => {
      idp = await startMockIdp();
      stack = await startStack(infra, {
        presets: ['public', 'organizations'],
        extraTrustedOrigins: [idp.base],
      });
    });
    afterAll(async () => {
      await stack?.stop();
      await idp?.stop();
    });

    it('stores enc:v1:… (AES-256-GCM), never the plain secret, and sign-in still works', async () => {
      const partner = await registerPartner(stack, idp, t, { domain: 'enc-u.test' });
      const { rows } = await stack.pool.query<{ oidc_config: string }>(
        `select oidc_config from identity.sso_provider where provider_id = $1`,
        [partner.providerId],
      );
      const raw = rows[0]!.oidc_config;
      expect(raw.includes(partner.clientSecret)).toBe(false);
      expect(JSON.parse(raw).clientSecret.startsWith(DEFAULTS.ssoSecretPrefix)).toBe(true);
      idp.loginAs({ sub: 'e-1', email: 'amy@enc-u.test', name: 'Amy' });
      const r = await ssoSignIn(stack.client(), { email: 'amy@enc-u.test' });
      expect(r.callback?.status).toBe(302);
      expect(r.callback?.location).toBe('/');
    });

    it('never returns the secret from the API', async () => {
      const partner = await registerPartner(stack, idp, t, { domain: 'quiet-u.test' });
      const list = await partner.owner.get(`${API}/sso/providers`);
      expect(list.body.includes(partner.clientSecret)).toBe(false);
      expect(list.body.includes(DEFAULTS.ssoSecretPrefix)).toBe(false);
    });

    it('refuses to build with SSO enabled and no (or a malformed) IDENTITY_ENCRYPTION_KEY', async () => {
      await expect(
        startStack(infra, { presets: ['organizations'], env: { [DEFAULTS.encryptionKeyEnv]: '' } }),
      ).rejects.toThrow(/IDENTITY_ENCRYPTION_KEY/);
      await expect(
        startStack(infra, {
          presets: ['organizations'],
          env: { [DEFAULTS.encryptionKeyEnv]: 'c2hvcnQ=' },
        }),
      ).rejects.toThrow(/32 bytes/);
    });
  });

  describe('D10 squatting: the three rules', () => {
    let stack: Stack;
    let idp: MockIdp;
    beforeAll(async () => {
      idp = await startMockIdp();
      stack = await startStack(infra, {
        presets: ['public', 'staff', 'organizations'],
        staff: { authority: idp.base },
        extraTrustedOrigins: [idp.base],
      });
    });
    afterAll(async () => {
      await stack?.stop();
      await idp?.stop();
    });

    it('rule 1: password sign-up is refused for the staff domain and for a verified SSO domain', async () => {
      const staff = await stack.client().post(`${API}/sign-up/email`, {
        email: `ceo@${STAFF_DOMAIN}`,
        password: strongPassword(),
        name: 'x',
      });
      expect(staff.status).toBe(403);
      expect(staff.json()).toMatchObject({ code: 'USE_COMPANY_SIGN_IN' });
      await registerPartner(stack, idp, t, { domain: 'locked-u.test' });
      const sso = await stack.client().post(`${API}/sign-up/email`, {
        email: 'kim@locked-u.test',
        password: strongPassword(),
        name: 'x',
      });
      expect(sso.status).toBe(403);
      await registerPartner(stack, idp, t, { domain: 'pending-u.test', verified: false });
      const pending = await stack.client().post(`${API}/sign-up/email`, {
        email: 'kim@pending-u.test',
        password: strongPassword(),
        name: 'x',
      });
      expect(pending.status).toBe(200); // an UNVERIFIED claim reserves nothing
    });

    it('rule 2: an unverified, never-used password account is replaced when a verified provider asserts the address', async () => {
      const email = `squat@${STAFF_DOMAIN}`;
      const password = strongPassword();
      const squatter = await stack.pool.query<{ id: string }>(
        `insert into identity."user" (id, name, email, email_verified, created_at, updated_at) values (uuidv7(), 'S', $1, false, now(), now()) returning id`,
        [email],
      );
      await stack.pool.query(
        `insert into identity.account (id, account_id, provider_id, user_id, password, created_at, updated_at)
         values (uuidv7(), $1::text, 'credential', $2::uuid, 'salt:attacker-known', now(), now())`,
        [squatter.rows[0]!.id, squatter.rows[0]!.id],
      );
      const { c, callback } = await entra(
        idp,
        { sub: 'x', oid: randomUUID(), tid: TEST_TENANT, email, name: 'Real Owner' },
        stack,
      )();
      expect(callback.status).toBe(302);
      expect((await c.get(`${API}/get-session`)).json()).not.toBeNull();
      const gone = await stack.pool.query(`select 1 from identity."user" where id = $1`, [
        squatter.rows[0]!.id,
      ]);
      expect(gone.rows).toHaveLength(0);
      expect(
        stack.events.some(
          (e) => e.name === 'account.unverified_replaced' && e.userId === squatter.rows[0]!.id,
        ),
      ).toBe(true);
      void password;
    });

    it('rule 2 never touches an account that has a session or a non-password account', async () => {
      const email = `used@${STAFF_DOMAIN}`;
      const used = await stack.pool.query<{ id: string }>(
        `insert into identity."user" (id, name, email, email_verified, created_at, updated_at) values (uuidv7(), 'U', $1, false, now(), now()) returning id`,
        [email],
      );
      await stack.pool.query(
        `insert into identity.session (id, token, user_id, expires_at, created_at, updated_at) values (uuidv7(), $1, $2::uuid, now() + interval '1 day', now(), now())`,
        [randomUUID(), used.rows[0]!.id],
      );
      const { c, callback } = await entra(
        idp,
        { sub: 'y', oid: randomUUID(), tid: TEST_TENANT, email, name: 'Owner' },
        stack,
      )();
      expect(callback.location).toMatch(/error=/);
      expect((await c.get(`${API}/get-session`)).json()).toBeNull();
      const still = await stack.pool.query(`select 1 from identity."user" where id = $1`, [
        used.rows[0]!.id,
      ]);
      expect(still.rows).toHaveLength(1);
    });

    it('rule 3: purgeUnverifiedAccounts() deletes unverified accounts older than 72 h that were never used', async () => {
      const insert = async (
        tag: string,
        verified: boolean,
        ageHours: number,
        extra?: 'session' | 'sso',
      ) => {
        const email = `${tag}-${randomUUID().slice(0, 6)}@users.identity.test`;
        const u = await stack.pool.query<{ id: string }>(
          `insert into identity."user" (id, name, email, email_verified, created_at, updated_at)
           values (uuidv7(), $1, $2, $3, now() - make_interval(hours => $4), now()) returning id`,
          [tag, email, verified, ageHours],
        );
        const id = u.rows[0]!.id;
        await stack.pool.query(
          `insert into identity.account (id, account_id, provider_id, user_id, created_at, updated_at) values (uuidv7(), $1::text, $2, $3::uuid, now(), now())`,
          [id, extra === 'sso' ? 'microsoft' : 'credential', id],
        );
        if (extra === 'session') {
          await stack.pool.query(
            `insert into identity.session (id, token, user_id, expires_at, created_at, updated_at) values (uuidv7(), $1, $2::uuid, now() + interval '1 day', now(), now())`,
            [randomUUID(), id],
          );
        }
        return id;
      };
      const stale = await insert('stale', false, 80);
      const fresh = await insert('fresh', false, 1);
      const verified = await insert('verified', true, 200);
      const withSession = await insert('session', false, 200, 'session');
      const sso = await insert('sso', false, 200, 'sso');
      expect(await purgeUnverifiedAccounts(stack.auth)).toBeGreaterThanOrEqual(1);
      const alive = async (id: string) =>
        (await stack.pool.query(`select 1 from identity."user" where id = $1`, [id])).rows
          .length === 1;
      expect(await alive(stale)).toBe(false);
      expect(await alive(fresh)).toBe(true);
      expect(await alive(verified)).toBe(true);
      expect(await alive(withSession)).toBe(true);
      expect(await alive(sso)).toBe(true);
      expect(
        stack.events.some((e) => e.name === 'account.unverified_purged' && e.userId === stale),
      ).toBe(true);
      expect(await purgeUnverifiedAccounts(stack.auth)).toBe(0); // idempotent
    });
  });

  describe('D11 staff: tenant check and B2B guests', () => {
    let idp: MockIdp;
    beforeAll(async () => {
      idp = await startMockIdp();
    });
    afterAll(() => idp?.stop());

    const staffStack = (staff?: Record<string, unknown>) =>
      startStack(infra, { presets: ['staff'], staff: { authority: idp.base, ...staff } });

    it('signs a tenant member in: verified, keyed by oid, 12-hour session, no cookie cache, no Graph scope', async () => {
      const stack = await staffStack();
      try {
        const oid = randomUUID();
        const email = `member@${STAFF_DOMAIN}`;
        const { c, callback } = await entra(
          idp,
          { sub: 'm', oid, tid: TEST_TENANT, email, name: 'Member' },
          stack,
        )();
        expect(callback.status).toBe(302);
        expect(Object.keys(c.cookies).some((n) => n.endsWith('session_data'))).toBe(false);
        const { rows } = await stack.pool.query<{
          account_id: string;
          email_verified: boolean;
          secs: number;
        }>(
          `select a.account_id, u.email_verified, extract(epoch from (s.expires_at - s.created_at))::int as secs
             from identity.account a join identity."user" u on u.id = a.user_id join identity.session s on s.user_id = u.id where u.email = $1`,
          [email],
        );
        expect(rows[0]).toMatchObject({ account_id: oid, email_verified: true });
        expect(
          Math.abs(rows[0]!.secs - DEFAULTS.session.staff.expiresInSeconds),
        ).toBeLessThanOrEqual(5);
        expect(stack.auth.options.session?.cookieCache?.enabled).toBe(false);
        const u = new URL(
          (
            await stack
              .client()
              .post(`${API}/sign-in/social`, { provider: 'microsoft', callbackURL: '/' })
          ).json<{ url: string }>().url,
        );
        expect(u.pathname).toBe(`/${TEST_TENANT}/oauth2/v2.0/authorize`);
        expect(u.searchParams.get('scope')).toBe('openid profile email');
      } finally {
        await stack.stop();
      }
    });

    it('REFUSES a token from another tenant (tid) and writes nothing', async () => {
      const stack = await staffStack();
      try {
        const email = `mallory@${STAFF_DOMAIN}`;
        const { c, callback } = await entra(
          idp,
          { sub: 'x', oid: randomUUID(), tid: OTHER_TENANT, email },
          stack,
        )();
        expect(callback.location).toMatch(/error=unable_to_get_user_info/);
        expect((await c.get(`${API}/get-session`)).json()).toBeNull();
        expect(
          (await stack.pool.query(`select 1 from identity."user" where email = $1`, [email])).rows,
        ).toHaveLength(0);
      } finally {
        await stack.stop();
      }
    });

    it('refuses B2B guests by default and admits them with staff.allowGuests', async () => {
      const guest = {
        sub: 'g',
        oid: randomUUID(),
        tid: TEST_TENANT,
        email: 'vendor@vendor.example',
        claims: { acct: 1 },
      };
      const closed = await staffStack();
      try {
        const { callback } = await entra(idp, guest, closed)();
        expect(callback.location).toMatch(/error=unable_to_get_user_info/);
      } finally {
        await closed.stop();
      }
      const open = await staffStack({ allowGuests: true });
      try {
        const { c } = await entra(idp, { ...guest, oid: randomUUID() }, open)();
        expect((await c.get(`${API}/get-session`)).json()).not.toBeNull();
      } finally {
        await open.stop();
      }
    });

    it('a token with no email claim cannot sign in; the staff preset has no password endpoints', async () => {
      const stack = await staffStack();
      try {
        const { callback } = await entra(
          idp,
          { sub: 'n', oid: randomUUID(), tid: TEST_TENANT, name: 'No Email' },
          stack,
        )();
        expect(callback.location).toMatch(/error=/);
        const res = await stack.client().post(`${API}/sign-up/email`, {
          email: uniqueEmail('p'),
          password: strongPassword(),
          name: 'x',
        });
        expect(res.status).toBe(400);
      } finally {
        await stack.stop();
      }
    });
  });

  describe('D12 bearer links in job payloads', () => {
    let stack: Stack;
    beforeAll(async () => {
      stack = await startStack(infra);
    });
    afterAll(() => stack?.stop());

    it('auth mail is enqueued with priority 10 and WITHOUT any per-send retention (retention belongs to the queue)', async () => {
      await verifiedUser(stack, uniqueEmail('prio'), strongPassword(), expect);
      await stack
        .client()
        .post(`${API}/request-password-reset`, { email: uniqueEmail('x'), redirectTo: '/r' });
      const { rows } = await stack.pool.query<{ options: Record<string, unknown>; queue: string }>(
        `select options, queue from identity_test_jobs`,
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.queue).toBe(MAIL_QUEUE);
        // exactly the options platform-jobs understands; `retention` is not one of them and would be ignored
        expect(Object.keys(row.options).sort()).toEqual(['idempotencyKey', 'priority']);
        expect(row.options['priority']).toBe(AUTH_MAIL_PRIORITY);
      }
      expect(AUTH_MAIL_PRIORITY).toBe(10);
    });

    it('fails closed: with mail.send not registered in the process, nothing is enqueued and nothing falls back to another queue', async () => {
      const unregistered = await startStack(infra, { registeredQueues: ['some.other.queue'] });
      try {
        const email = uniqueEmail('closed');
        // Better Auth swallows a throwing callback (WP-9 D6): the request still answers, but no link exists anywhere.
        const res = await unregistered
          .client()
          .post(`${API}/sign-up/email`, { email, password: strongPassword(), name: 'x' });
        expect(res.status).toBe(200);
        const { rows } = await unregistered.pool.query(`select 1 from identity_test_jobs`);
        expect(rows).toHaveLength(0);
      } finally {
        await unregistered.stop();
      }
    });

    it('the idempotency key is purpose:user:sha256(token) and never contains the token', async () => {
      const email = uniqueEmail('key');
      await stack
        .client()
        .post(`${API}/sign-up/email`, { email, password: strongPassword(), name: 'x' });
      const link = await stack.link(email);
      const token = new URL(link).searchParams.get('token')!;
      const { rows } = await stack.pool.query<{ id: string }>(
        `select id from identity."user" where email = $1`,
        [email],
      );
      const job = await stack.pool.query<{ idempotency_key: string }>(
        `select idempotency_key from identity_test_jobs where data->>'to' = $1`,
        [email],
      );
      expect(job.rows[0]!.idempotency_key).toBe(
        mailIdempotencyKey('verify-email', rows[0]!.id, token),
      );
      expect(job.rows[0]!.idempotency_key.includes(token)).toBe(false);
    });

    it('the sign-up mail joins the transaction: a failed commit leaves no user and no job', async () => {
      await stack.pool.query(`
        create or replace function identity.poison_check() returns trigger language plpgsql as $$
        begin
          if exists (select 1 from identity."user" u where u.id = new.user_id and u.email like 'poison+%') then
            raise exception 'poisoned commit';
          end if;
          return null;
        end $$;
        create constraint trigger poison after insert on identity.account
          deferrable initially deferred for each row execute function identity.poison_check();`);
      const email = `poison+${randomUUID().slice(0, 8)}@users.identity.test`;
      const res = await stack
        .client()
        .post(`${API}/sign-up/email`, { email, password: strongPassword(), name: 'p' });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(
        (await stack.pool.query(`select 1 from identity."user" where email = $1`, [email])).rows,
      ).toHaveLength(0);
      expect(
        (await stack.pool.query(`select 1 from identity_test_jobs where data->>'to' = $1`, [email]))
          .rows,
      ).toHaveLength(0);
    });

    it('D14: more than 3 reset requests per email per hour are dropped SILENTLY (same answer, no 4th mail)', async () => {
      const email = uniqueEmail('bomb');
      await verifiedUser(stack, email, strongPassword(), expect);
      const before = (await stack.mail()).filter(
        (m) => m.to === email && m.category === 'auth.reset-password',
      ).length;
      const answers: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        const res = await stack
          .client()
          .post(`${API}/request-password-reset`, { email, redirectTo: '/r' });
        expect(res.status).toBe(200);
        answers.push(res.body);
      }
      expect(new Set(answers).size).toBe(1);
      const after = (await stack.mail()).filter(
        (m) => m.to === email && m.category === 'auth.reset-password',
      ).length;
      expect(after - before).toBe(
        DEFAULTS.mailPerEmail.max -
          1 /* the sign-up mail used one of the 3 verification slots, reset has its own */ +
          1,
      );
    });
  });

  describe('D13 + D15 + D16 SSO registration, linking and SSRF', () => {
    let stack: Stack;
    let idp: MockIdp;
    beforeAll(async () => {
      idp = await startMockIdp();
      stack = await startStack(infra, {
        presets: ['public', 'staff', 'organizations'],
        staff: { authority: idp.base },
        extraTrustedOrigins: [idp.base],
      });
    });
    afterAll(async () => {
      await stack?.stop();
      await idp?.stop();
    });

    const body = (organizationId: string | undefined, domain: string, base = idp.base) => ({
      providerId: `p-${randomUUID().slice(0, 8)}`,
      issuer: `${base}/oidc`,
      domain,
      ...(organizationId ? { organizationId } : {}),
      oidcConfig: {
        clientId: 'c',
        clientSecret: `s-${randomUUID()}`,
        discoveryEndpoint: `${base}/.well-known/openid-configuration`,
        pkce: true,
        mapping: { email: 'email', emailVerified: 'email_verified', name: 'name' },
      },
    });

    it('D13: registration is default deny — organization owner/admin only, never a staff domain', async () => {
      const user = await verifiedUser(stack, uniqueEmail('anyone'), strongPassword(), expect);
      const noOrg = await user.post(`${API}/sso/register`, body(undefined, 'victim.test'));
      expect(noOrg.status).toBe(403);
      expect(noOrg.json()).toMatchObject({ code: 'SSO_ORGANIZATION_REQUIRED' });

      const partner = await registerPartner(stack, idp, t, { domain: 'ok-u.test' });
      const reserved = await partner.owner.post(
        `${API}/sso/register`,
        body(partner.organizationId, STAFF_DOMAIN),
      );
      expect(reserved.status).toBe(403);
      expect(reserved.json()).toMatchObject({ code: 'SSO_DOMAIN_RESERVED' });

      // a plain member of the organization is not an owner/admin
      const member = await verifiedUser(stack, uniqueEmail('member'), strongPassword(), expect);
      const { rows } = await stack.pool.query<{ id: string }>(
        `select id from identity."user" order by created_at desc limit 1`,
      );
      await stack.pool.query(
        `insert into identity.member (id, organization_id, user_id, role, created_at) values (uuidv7(), $1::uuid, $2::uuid, 'member', now())`,
        [partner.organizationId, rows[0]!.id],
      );
      const asMember = await member.post(
        `${API}/sso/register`,
        body(partner.organizationId, 'member-u.test'),
      );
      expect(asMember.status).toBe(403);
    });

    it('D13: a registered provider is unusable until its domain is verified', async () => {
      const partner = await registerPartner(stack, idp, t, {
        domain: 'unverified-u.test',
        verified: false,
      });
      idp.loginAs({ sub: 'u1', email: 'a@unverified-u.test' });
      const r = await ssoSignIn(stack.client(), { email: 'a@unverified-u.test' });
      expect(r.start.status).toBe(401);
      void partner;
    });

    it('D15: an asserted address outside the provider domain is rejected, nothing persisted', async () => {
      await registerPartner(stack, idp, t, { domain: 'bound-u.test' });
      idp.loginAs({ sub: 'b1', email: 'ceo@qnsc-foreign.test' });
      const c = stack.client();
      const r = await ssoSignIn(c, { email: 'x@bound-u.test' });
      expect(r.callback?.location).toMatch(/EMAIL_OUTSIDE_PROVIDER_DOMAIN/);
      expect(
        (
          await stack.pool.query(
            `select 1 from identity."user" where email = 'ceo@qnsc-foreign.test'`,
          )
        ).rows,
      ).toHaveLength(0);
    });

    it("D15: an existing local account is auto-linked ONLY if it belongs to the provider's organization", async () => {
      const partner = await registerPartner(stack, idp, t, { domain: 'link-u.test' });
      const outsider = 'outsider@link-u.test';
      await verifiedUser(stack, outsider, strongPassword(), expect).catch(() => undefined);
      // a local verified account for that address that is NOT a member
      await stack.pool.query(
        `insert into identity."user" (id, name, email, email_verified, created_at, updated_at) values (uuidv7(), 'O', $1, true, now(), now())`,
        [outsider],
      );
      idp.loginAs({ sub: 'l1', email: outsider });
      const c = stack.client();
      const blocked = await ssoSignIn(c, { email: outsider });
      expect(blocked.callback?.location).toMatch(/ACCOUNT_LINK_REQUIRED/);
      expect((await c.get(`${API}/get-session`)).json()).toBeNull();

      const insider = 'insider@link-u.test';
      const u = await stack.pool.query<{ id: string }>(
        `insert into identity."user" (id, name, email, email_verified, created_at, updated_at) values (uuidv7(), 'I', $1, true, now(), now()) returning id`,
        [insider],
      );
      await stack.pool.query(
        `insert into identity.member (id, organization_id, user_id, role, created_at) values (uuidv7(), $1::uuid, $2::uuid, 'member', now())`,
        [partner.organizationId, u.rows[0]!.id],
      );
      idp.loginAs({ sub: 'l2', email: insider });
      const ok = stack.client();
      await ssoSignIn(ok, { email: insider });
      expect((await ok.get(`${API}/get-session`)).json()).not.toBeNull();
    });

    it('D16: refuses http, loopback, private and link-local URLs at registration', async () => {
      const strict = await startStack(infra, {
        presets: ['public', 'organizations'],
        unsafeTestNetwork: false,
      });
      try {
        const { organizationId, owner } = await createOrganization(strict, t);
        for (const base of [
          'http://idp.example',
          'https://127.0.0.1',
          'https://10.0.0.5',
          'https://169.254.169.254',
          'https://[::1]',
        ]) {
          const res = await owner.post(
            `${API}/sso/register`,
            body(organizationId, 'ssrf.test', base),
          );
          expect(res.status, base).toBe(400);
          expect(res.json(), base).toMatchObject({ code: 'SSO_URL_NOT_ALLOWED' });
        }
      } finally {
        await strict.stop();
      }
    });

    it('D16: at fetch time a stored provider with an unsafe URL is never trusted, so nothing is fetched', async () => {
      const strict = await startStack(infra, {
        presets: ['public', 'organizations'],
        unsafeTestNetwork: false,
      });
      try {
        const owner = await verifiedUser(strict, uniqueEmail('owner'), strongPassword(), expect);
        const org = await strict.pool.query<{ id: string }>(
          `insert into identity.organization (id, name, slug, created_at) values (uuidv7(), 'R', 'rebind', now()) returning id`,
        );
        const ownerId = (
          await strict.pool.query<{ id: string }>(`select id from identity."user" limit 1`)
        ).rows[0]!.id;
        await strict.pool.query(
          `insert into identity.sso_provider (id, issuer, oidc_config, user_id, provider_id, organization_id, domain, domain_verified)
           values (uuidv7(), 'https://10.0.0.5/oidc', $1, $2::uuid, 'rebind', $3::uuid, 'rebind.test', true)`,
          [
            JSON.stringify({
              clientId: 'c',
              clientSecret: 's',
              discoveryEndpoint: 'https://10.0.0.5/.well-known/openid-configuration',
              tokenEndpoint: 'https://10.0.0.5/token',
              jwksEndpoint: 'https://10.0.0.5/jwks',
              authorizationEndpoint: 'https://10.0.0.5/authorize',
            }),
            ownerId,
            org.rows[0]!.id,
          ],
        );
        // Count every outbound fetch the sign-in makes: none may go to the internal address.
        const outbound: string[] = [];
        const realFetch = globalThis.fetch;
        globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
          outbound.push(
            typeof input === 'string' || input instanceof URL ? String(input) : input.url,
          );
          return realFetch(input, init);
        }) as typeof fetch;
        let res;
        try {
          res = await strict
            .client()
            .post(`${API}/sign-in/sso`, { email: 'a@rebind.test', callbackURL: '/' });
        } finally {
          globalThis.fetch = realFetch;
        }
        expect(res.status).toBe(400);
        expect(JSON.parse(res.body)).toMatchObject({ code: 'discovery_private_host' }); // Better Auth's own fetch-time guard
        expect(outbound.filter((u) => u.includes('10.0.0.5'))).toEqual([]);
        void owner;
      } finally {
        await strict.stop();
      }
    });
  });

  describe('D17 test-login', () => {
    it('loads only with IDENTITY_TEST_LOGIN=enabled AND not production; refuses to build otherwise', async () => {
      await expect(startStack(infra, { testLogin: true })).rejects.toThrow(/test-login refused/);
      await expect(
        startStack(infra, {
          testLogin: true,
          env: { IDENTITY_TEST_LOGIN: 'enabled', NODE_ENV: 'production' },
          unsafeTestNetwork: false,
        }),
      ).rejects.toThrow(/test-login refused/);
      await expect(
        startStack(infra, { testLogin: true, env: { IDENTITY_TEST_LOGIN: 'true' } }),
      ).rejects.toThrow(/not "enabled"/);
    });

    it('works when explicitly enabled, and is absent when not requested even if the env is set', async () => {
      const on = await startStack(infra, {
        testLogin: true,
        env: { IDENTITY_TEST_LOGIN: 'enabled' },
      });
      try {
        const c = on.client();
        const res = await c.post(`${API}/test-login`, { email: uniqueEmail('e2e') });
        expect(res.status, res.body).toBe(200);
        expect((await c.get(`${API}/get-session`)).json()).not.toBeNull();
      } finally {
        await on.stop();
      }
      const off = await startStack(infra, { env: { IDENTITY_TEST_LOGIN: 'enabled' } });
      try {
        expect(
          (await off.client().post(`${API}/test-login`, { email: uniqueEmail('e2e') })).status,
        ).toBe(404);
      } finally {
        await off.stop();
      }
    });
  });

  describe('D18 + D20 scope', () => {
    it('D18: staff, public, organizations, OIDC SSO, twoFactor and admin answer; passkeys and the jwt plugin do not exist', async () => {
      const stack = await startStack(infra, { presets: ['public', 'staff', 'organizations'] });
      try {
        const c = await verifiedUser(stack, uniqueEmail('scope'), strongPassword(), expect);
        // in: these routes exist (any status but 404 proves the plugin is mounted)
        expect((await c.get(`${API}/organization/list`)).status).toBe(200);
        expect((await c.get(`${API}/sso/providers`)).status).not.toBe(404);
        expect((await c.post(`${API}/two-factor/enable`, {})).status).not.toBe(404);
        expect((await c.get(`${API}/admin/list-users`)).status).toBe(403); // mounted, not an admin
        // out until a product needs them (identity plan D18)
        expect((await c.post(`${API}/passkey/generate-register-options`, {})).status).toBe(404);
        expect((await c.get(`${API}/token`)).status).toBe(404);
        expect((await c.get(`${API}/jwks`)).status).toBe(404);
        expect((await c.get(`${API}/sso/saml2/sp/metadata?providerId=x`)).status).toBe(404);
      } finally {
        await stack.stop();
      }
    });

    it('D20: the exported purgeUnverifiedAccounts() deletes a stale unverified account; registerIdentityJobs schedules it hourly in Asia/Ho_Chi_Minh', async () => {
      const stack = await startStack(infra);
      try {
        const stale = await stack.pool.query<{ id: string }>(
          `insert into identity."user" (id, name, email, email_verified, created_at, updated_at)
           values (uuidv7(), 'S', $1, false, now() - interval '100 hours', now()) returning id`,
          [uniqueEmail('stale')],
        );
        const scheduled: Array<{ name: string; cron: string; tz?: string }> = [];
        let handler: ((job: { data: unknown }) => Promise<void>) | undefined;
        await registerIdentityJobs(
          {
            schedule: (name, cron, _data, options) => {
              scheduled.push({ name, cron, ...(options?.tz ? { tz: options.tz } : {}) });
            },
            handle: (_queue, fn) => {
              handler = fn;
            },
          },
          stack.auth,
        );
        expect(scheduled).toEqual([
          { name: 'identity.purge-unverified', cron: '0 * * * *', tz: 'Asia/Ho_Chi_Minh' },
        ]);
        await handler!({ data: {} });
        const gone = await stack.pool.query(`select 1 from identity."user" where id = $1`, [
          stale.rows[0]!.id,
        ]);
        expect(gone.rows).toHaveLength(0);
        expect(await rootPurge(stack.auth)).toBe(0); // nothing left, and it is safe to run again
      } finally {
        await stack.stop();
      }
    });
  });
}

import { hash as argon2hash } from '@node-rs/argon2';
import { createIdentity, createIdentityInternal } from '../create-identity';
import { DEFAULTS } from '../defaults';
import { CacheService } from '@quynhonsemiconductor/platform-cache';
import { verifiedUser, signIn } from './flows';
import {
  API,
  APP_ORIGIN,
  startStack,
  strongPassword,
  uniqueEmail,
  type ConformanceInfra,
  type Stack,
} from './harness';
import { lockoutKeys } from '../lockout';
import { totp, type TestApi } from './support';

/**
 * Identity plan §5.4, row by row. Each `it` names the row it asserts; a failing one means a secure
 * default is no longer in force.
 */
/**
 * Reads that bypass the public cookie cache. With the cache on (public preset, 5 minutes) a signed
 * cookie answers `get-session` without asking the database, which is the documented revocation
 * window; revocation itself is asserted against the real session.
 */
const FRESH = `${API}/get-session?disableCookieCache=true`;

export function defaultsConformance(t: TestApi, infra: ConformanceInfra): void {
  const { describe, it, beforeAll, afterAll, expect } = t;

  describe('§5.4 password hashing and policy', () => {
    let stack: Stack;
    beforeAll(async () => {
      stack = await startStack(infra);
    });
    afterAll(() => stack?.stop());

    it('hashes with argon2id at m=19456, t=2, p=1', async () => {
      const email = uniqueEmail('hash');
      await verifiedUser(stack, email, strongPassword(), expect);
      const { rows } = await stack.pool.query<{ password: string }>(
        `select a.password from identity.account a join identity."user" u on u.id = a.user_id where u.email = $1`,
        [email],
      );
      const { memoryCost, timeCost, parallelism } = DEFAULTS.password.argon2;
      expect(
        rows[0]!.password.startsWith(
          `$argon2id$v=19$m=${memoryCost},t=${timeCost},p=${parallelism}$`,
        ),
      ).toBe(true);
    });

    it('requires 12..128 characters and no composition rules', async () => {
      const reject = async (password: string) =>
        stack
          .client()
          .post(`${API}/sign-up/email`, { email: uniqueEmail('policy'), password, name: 'x' });
      expect((await reject('a'.repeat(11))).status).toBe(400);
      expect((await reject('a'.repeat(129))).status).toBe(400);
      expect((await reject('abcdefghijkl')).status).toBe(200); // 12 lower-case letters
      expect((await reject('a'.repeat(128))).status).toBe(200);
    });

    it('verifies an argon2id hash minted with other parameters (existing product hashes)', async () => {
      const email = uniqueEmail('legacy');
      const password = strongPassword();
      const legacy = await argon2hash(password, {
        memoryCost: 65536,
        timeCost: 3,
        parallelism: 4,
        algorithm: 2,
      });
      const user = await stack.pool.query<{ id: string }>(
        `insert into identity."user" (id, name, email, email_verified, created_at, updated_at) values (uuidv7(), 'L', $1, true, now(), now()) returning id`,
        [email],
      );
      await stack.pool.query(
        `insert into identity.account (id, account_id, provider_id, user_id, password, created_at, updated_at)
         values (uuidv7(), $1::text, 'credential', $2::uuid, $3, now(), now())`,
        [user.rows[0]!.id, user.rows[0]!.id, legacy],
      );
      expect((await signIn(stack.client(), email, password)).status).toBe(200);
      expect((await signIn(stack.client(), email, strongPassword())).status).toBe(401);
    });

    it('a hash in another format is a 401, never a 500', async () => {
      const email = uniqueEmail('odd');
      const user = await stack.pool.query<{ id: string }>(
        `insert into identity."user" (id, name, email, email_verified, created_at, updated_at) values (uuidv7(), 'O', $1, true, now(), now()) returning id`,
        [email],
      );
      await stack.pool.query(
        `insert into identity.account (id, account_id, provider_id, user_id, password, created_at, updated_at)
         values (uuidv7(), $1::text, 'credential', $2::uuid, 'salt:notargon2', now(), now())`,
        [user.rows[0]!.id, user.rows[0]!.id],
      );
      expect((await signIn(stack.client(), email, strongPassword())).status).toBe(401);
    });
  });

  describe('§5.4 email verification and password reset', () => {
    let stack: Stack;
    beforeAll(async () => {
      stack = await startStack(infra);
    });
    afterAll(() => stack?.stop());

    it('refuses sign-in until the address is verified', async () => {
      const email = uniqueEmail('unverified');
      const password = strongPassword();
      const c = stack.client();
      await c.post(`${API}/sign-up/email`, { email, password, name: 'x' });
      const res = await signIn(c, email, password);
      expect(res.status).toBe(403);
      expect(res.json()).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
      expect(res.setCookie.some((l) => /session_token/.test(l))).toBe(false);
    });

    it('a verification link verifies only its own address', async () => {
      const a = uniqueEmail('va');
      const b = uniqueEmail('vb');
      const ca = stack.client();
      await ca.post(`${API}/sign-up/email`, { email: a, password: strongPassword(), name: 'x' });
      await stack
        .client()
        .post(`${API}/sign-up/email`, { email: b, password: strongPassword(), name: 'x' });
      await ca.get(await stack.link(a));
      const { rows } = await stack.pool.query<{ email: string; email_verified: boolean }>(
        `select email, email_verified from identity."user" where email in ($1, $2)`,
        [a, b],
      );
      const state = Object.fromEntries(rows.map((r) => [r.email, r.email_verified]));
      expect(state[a]).toBe(true);
      expect(state[b]).toBe(false);
    });

    it('reset: single-use token, 15 minutes, stored hashed, and EVERY session is revoked', async () => {
      const email = uniqueEmail('reset');
      const oldPassword = strongPassword();
      const newPassword = strongPassword();
      const first = await verifiedUser(stack, email, oldPassword, expect);
      const second = stack.client();
      await signIn(second, email, oldPassword);
      expect((await first.get(`${API}/get-session`)).json()).not.toBeNull();

      const anon = stack.client();
      expect(
        (await anon.post(`${API}/request-password-reset`, { email, redirectTo: '/reset' })).status,
      ).toBe(200);
      const mail = (await stack.mail()).filter(
        (m) => m.to === email && m.category === 'auth.reset-password',
      );
      const token = new URL(mail.at(-1)!.text).pathname.split('/').pop()!;

      const ttl = await stack.pool.query<{ ttl: number }>(
        `select extract(epoch from (expires_at - created_at))::int as ttl from identity.verification order by created_at desc limit 1`,
      );
      expect(ttl.rows[0]!.ttl).toBeLessThanOrEqual(DEFAULTS.reset.tokenTtlSeconds);
      expect(ttl.rows[0]!.ttl).toBeGreaterThan(DEFAULTS.reset.tokenTtlSeconds - 60);
      const plain = await stack.pool.query(
        `select 1 from identity.verification where identifier like '%' || $1 || '%'`,
        [token],
      );
      expect(plain.rows).toHaveLength(0);

      expect((await anon.post(`${API}/reset-password`, { token, newPassword })).status).toBe(200);
      expect((await first.get(FRESH)).json()).toBeNull();
      expect((await second.get(FRESH)).json()).toBeNull();
      expect(
        (await anon.post(`${API}/reset-password`, { token, newPassword: strongPassword() })).status,
      ).toBe(400);
      expect((await signIn(stack.client(), email, oldPassword)).status).toBe(401);
      expect((await signIn(stack.client(), email, newPassword)).status).toBe(200);
    });
  });

  describe('§5.4 sessions and cookies', () => {
    let stack: Stack;
    beforeAll(async () => {
      stack = await startStack(infra);
    });
    afterAll(() => stack?.stop());

    it('public sessions last 7 days, sliding, with a 5-minute cookie cache', async () => {
      const email = uniqueEmail('life');
      const c = await verifiedUser(stack, email, strongPassword(), expect);
      expect(stack.auth.options.session?.expiresIn).toBe(DEFAULTS.session.public.expiresInSeconds);
      expect(stack.auth.options.session?.updateAge).toBe(DEFAULTS.session.public.updateAgeSeconds);
      expect(stack.auth.options.session?.cookieCache).toMatchObject({
        enabled: true,
        maxAge: DEFAULTS.session.cookieCacheSeconds,
      });
      // sliding: age the session by two days and read it
      await stack.pool.query(
        `update identity.session s set created_at = now() - interval '2 days', updated_at = now() - interval '2 days',
                expires_at = now() + interval '5 days' from identity."user" u where u.id = s.user_id and u.email = $1`,
        [email],
      );
      await stack.flushCache(); // the cached session still carries the old expiry
      await c.get(FRESH);
      const { rows } = await stack.pool.query<{ days: number }>(
        `select extract(epoch from (s.expires_at - now()))/86400 as days from identity.session s join identity."user" u on u.id = s.user_id where u.email = $1`,
        [email],
      );
      expect(Number(rows[0]!.days)).toBeGreaterThan(6.5);
    });

    it('cookies are __Secure- prefixed, HttpOnly, Secure, SameSite=Lax, host-only', async () => {
      const email = uniqueEmail('cookie');
      const password = strongPassword();
      const c = stack.client();
      await c.post(`${API}/sign-up/email`, { email, password, name: 'x' });
      await c.get(await stack.link(email));
      const line = (await signIn(c, email, password)).setCookie.find((l) =>
        /session_token/.test(l),
      )!;
      expect(line.split('=')[0]).toBe('__Secure-conformance.session_token');
      for (const attribute of [
        /;\s*HttpOnly/i,
        /;\s*Secure/i,
        /;\s*SameSite=Lax/i,
        /;\s*Path=\//i,
        /;\s*Max-Age=604800/i,
      ]) {
        expect(attribute.test(line), String(attribute)).toBe(true);
      }
      expect(/;\s*Domain=/i.test(line)).toBe(false);
    });

    it('revocation is effective on the next request: sign-out, sign-out-everywhere, one other session', async () => {
      const email = uniqueEmail('revoke');
      const password = strongPassword();
      const a = await verifiedUser(stack, email, password, expect);
      const b = stack.client();
      const signed = await signIn(b, email, password);
      const stale = { ...b.cookies };
      expect(
        (await a.post(`${API}/revoke-session`, { token: signed.json<{ token: string }>().token }))
          .status,
      ).toBe(200);
      const replay = stack.client();
      replay.setCookies(stale);
      expect((await replay.get(FRESH)).json()).toBeNull();
      expect((await a.post(`${API}/revoke-sessions`, {})).status).toBe(200);
      expect((await a.get(FRESH)).json()).toBeNull();
    });

    it('a planted session cookie is not adopted at sign-in (no fixation)', async () => {
      const email = uniqueEmail('fix');
      const password = strongPassword();
      const victim = await verifiedUser(stack, email, password, expect);
      const planted = { ...victim.cookies };
      const attacker = stack.client();
      attacker.setCookies(planted);
      await signIn(attacker, email, password);
      const [name] = Object.keys(planted);
      expect(attacker.cookies[name!]).not.toBe(planted[name!]);
    });

    it('IDs are uuidv7', async () => {
      const email = uniqueEmail('v7');
      await verifiedUser(stack, email, strongPassword(), expect);
      for (const table of ['user', 'account', 'session', 'verification']) {
        const { rows } = await stack.pool.query<{ version: string }>(
          `select distinct substring(id::text from 15 for 1) as version from identity."${table}"`,
        );
        expect(
          rows.every((r) => r.version === '7'),
          table,
        ).toBe(true);
      }
    });
  });

  describe('§5.4 origins, redirects, secrets', () => {
    let stack: Stack;
    beforeAll(async () => {
      stack = await startStack(infra);
    });
    afterAll(() => stack?.stop());

    it('refuses a state-changing request from an untrusted Origin, with or without a session', async () => {
      const evil = stack.client({ origin: 'https://evil.example' });
      expect(
        (
          await evil.post(`${API}/sign-in/email`, {
            email: uniqueEmail('x'),
            password: strongPassword(),
          })
        ).status,
      ).toBe(403);
      const real = await verifiedUser(stack, uniqueEmail('csrf'), strongPassword(), expect);
      const attacker = stack.client({ origin: 'https://evil.example' });
      attacker.setCookies(real.cookies);
      expect((await attacker.post(`${API}/sign-out`, {})).status).toBe(403);
    });

    it('refuses a callback / redirect URL outside trustedOrigins', async () => {
      const res = await stack.client().post(`${API}/request-password-reset`, {
        email: uniqueEmail('r'),
        redirectTo: 'https://evil.example/x',
      });
      expect(res.status).toBe(403);
    });

    it('pins the origin, CSRF and rate-limit switches that Better Auth ties to NODE_ENV', () => {
      expect(stack.auth.options.advanced?.disableOriginCheck).toBe(false);
      expect(stack.auth.options.advanced?.disableCSRFCheck).toBe(false);
      expect(stack.auth.options.rateLimit?.enabled).toBe(true);
      expect(stack.auth.options.rateLimit?.storage).toBe('secondary-storage');
      expect(stack.auth.options.advanced?.useSecureCookies).toBe(true);
      expect(stack.auth.options.telemetry?.enabled).toBe(false);
    });

    it('refuses to build without trustedOrigins, a secret, https in production, or a staff config', () => {
      const base = {
        product: 'x',
        db: {},
        schema: {},
        cache: new CacheService({ mode: 'optional' }),
        baseURL: APP_ORIGIN,
        trustedOrigins: [APP_ORIGIN],
        presets: ['public' as const],
        mail: {
          jobs: { send: async () => null },
          templates: {
            verifyEmail: () => ({ subject: '', html: '', text: '' }),
            resetPassword: () => ({ subject: '', html: '', text: '' }),
          },
        },
        env: { [DEFAULTS.secretEnv]: 'x'.repeat(40) },
      };
      expect(() => createIdentity({ ...base, trustedOrigins: [] })).toThrow(/trustedOrigins/);
      expect(() => createIdentity({ ...base, env: {} })).toThrow(new RegExp(DEFAULTS.secretEnv));
      expect(() =>
        createIdentity({
          ...base,
          env: { ...base.env, NODE_ENV: 'production' },
          baseURL: 'http://x.test',
        }),
      ).toThrow(/https/);
      expect(() => createIdentity({ ...base, presets: ['staff'] })).toThrow(/staff/);
      expect(() => createIdentity({ ...base, presets: ['organizations'] })).toThrow(
        new RegExp(DEFAULTS.encryptionKeyEnv),
      );
      expect(() =>
        createIdentityInternal(
          { ...base, env: { ...base.env, NODE_ENV: 'production' }, baseURL: 'https://x.test' },
          { unsafeTestNetwork: true },
        ),
      ).toThrow(/production/);
    });

    it('Better Auth reads the client address from ONE header, and its rate limiter keys on it', async () => {
      expect(stack.auth.options.advanced?.ipAddress?.ipAddressHeaders).toEqual([
        DEFAULTS.clientIpHeader,
      ]);
      const codes: number[] = [];
      const c = stack.client({ ip: '203.0.113.250' });
      for (let i = 0; i < 5; i += 1)
        codes.push((await signIn(c, uniqueEmail('rl'), strongPassword())).status);
      expect(codes).toEqual([401, 401, 401, 429, 429]); // built-in rule: 3 sign-ins / 10 s / IP
      expect(
        (await signIn(stack.client({ ip: '203.0.113.251' }), uniqueEmail('rl'), strongPassword()))
          .status,
      ).toBe(401);
      const keys = await stack.keys('203.0.113.250|*');
      expect(keys.length).toBeGreaterThan(0);
    });
  });

  describe('§5.4 lockout, enumeration, timing', () => {
    let stack: Stack;
    /** The counter generation a subject is on (a success or a reset moves it on). */
    const generation = async (subject: string): Promise<number> =>
      Number(await stack.get(lockoutKeys.gen(subject))) || 0;
    beforeAll(async () => {
      stack = await startStack(infra);
    });
    afterAll(() => stack?.stop());

    it('locks an account for ONE client address after 5 failures in 15 minutes; the owner on another address is not locked out', async () => {
      const email = uniqueEmail('lock');
      const password = strongPassword();
      await verifiedUser(stack, email, password, expect);
      const attacker = '203.0.113.10';
      // Better Auth's own per-IP rule is 3 sign-ins / 10 s, so five attempts take two bursts.
      for (let i = 0; i < 3; i += 1) {
        expect((await signIn(stack.client({ ip: attacker }), email, strongPassword())).status).toBe(
          401,
        );
      }
      await new Promise((r) => setTimeout(r, 10_200));
      for (let i = 0; i < 2; i += 1) {
        expect((await signIn(stack.client({ ip: attacker }), email, strongPassword())).status).toBe(
          401,
        );
      }
      await new Promise((r) => setTimeout(r, 10_200));
      const locked = await signIn(stack.client({ ip: attacker }), email, password); // the RIGHT password
      expect(locked.status).toBe(429);
      expect(locked.json()).toMatchObject({ code: 'ACCOUNT_LOCKED' });
      // the denial-of-service this must not allow: the owner, elsewhere, signs in
      expect((await signIn(stack.client({ ip: '198.51.100.7' }), email, password)).status).toBe(
        200,
      );
      const keys = await stack.keys('lockout:*');
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys.filter((k) => !k.includes('lockout:gen:'))) {
        expect(await stack.ttl(key)).toBeLessThanOrEqual(DEFAULTS.lockout.perAccount.windowSeconds);
      }
    }, 60_000);

    it('2FA verification has the same two layers: locked per account and address, not per account', async () => {
      const email = uniqueEmail('mfa');
      const password = strongPassword();
      const c = await verifiedUser(stack, email, password, expect);
      const enable = await c.post(`${API}/two-factor/enable`, { password });
      expect(enable.status, enable.body).toBe(200);
      const secret = new URL(enable.json<{ totpURI: string }>().totpURI).searchParams.get(
        'secret',
      )!;
      expect((await c.post(`${API}/two-factor/verify-totp`, { code: totp(secret) })).status).toBe(
        200,
      );
      await c.post(`${API}/sign-out`, {});

      const userId = (
        await stack.pool.query<{ id: string }>(`select id from identity."user" where email = $1`, [
          email,
        ])
      ).rows[0]!.id;
      const attackerIp = '203.0.113.20';
      await stack.seedCounter(
        lockoutKeys.accountAndIp('2fa', await generation(userId), userId, attackerIp),
        DEFAULTS.lockout.perAccountAndIp.maxAttempts,
      );

      const challenge = stack.client({ ip: '198.51.100.20' });
      expect((await signIn(challenge, email, password)).json()).toMatchObject({
        twoFactorRedirect: true,
      });
      const fromAttacker = stack.client({ ip: attackerIp });
      fromAttacker.setCookies(challenge.cookies);
      const locked = await fromAttacker.post(`${API}/two-factor/verify-totp`, {
        code: totp(secret),
      });
      expect(locked.status).toBe(429);
      expect(locked.json()).toMatchObject({ code: 'ACCOUNT_LOCKED' });
      // the owner's own address is untouched
      expect(
        (await challenge.post(`${API}/two-factor/verify-totp`, { code: totp(secret) })).status,
      ).toBe(200);
    });

    it('per account, from any address: a progressive delay, no lock, and a ceiling of 50 attempts an hour', async () => {
      const email = uniqueEmail('delay');
      const password = strongPassword();
      await verifiedUser(stack, email, password, expect);
      const { freeAttempts, delayStepMs, ceiling } = DEFAULTS.lockout.perAccount;
      await stack.seedCounter(
        lockoutKeys.account('signin', await generation(email), email),
        freeAttempts,
        3600,
      );
      const started = performance.now();
      const slowed = await signIn(stack.client({ ip: '198.51.100.31' }), email, password);
      expect(slowed.status).toBe(200); // not locked: the owner still gets in
      expect(performance.now() - started).toBeGreaterThanOrEqual(delayStepMs - 20);

      const flooded = uniqueEmail('ceiling');
      await verifiedUser(stack, flooded, password, expect);
      await stack.seedCounter(
        lockoutKeys.account('signin', await generation(flooded), flooded),
        ceiling,
        3600,
      );
      const refused = await signIn(stack.client({ ip: '198.51.100.32' }), flooded, password);
      expect(refused.status).toBe(429);
      expect(refused.json()).toMatchObject({ code: 'ACCOUNT_LOCKED' });
    });

    /** The known-device cookie out of a client's jar, as a jar of its own: what a returning browser carries. */
    const deviceJar = (c: { cookies: Record<string, string> }): Record<string, string> =>
      Object.fromEntries(
        Object.entries(c.cookies).filter(([name]) => name.endsWith('.known_device')),
      );

    it('a successful sign-in sets a signed, HttpOnly, Secure known-device cookie (and only that) per account', async () => {
      const email = uniqueEmail('device');
      const password = strongPassword();
      const c = stack.client();
      await c.post(`${API}/sign-up/email`, { email, password, name: 'x' });
      await c.get(await stack.link(email));
      const res = await signIn(c, email, password);
      const line = res.setCookie.find((l) => /known_device/.test(l))!;
      expect(line.split('=')[0]).toBe('__Secure-conformance.known_device');
      for (const attribute of [
        /;\s*HttpOnly/i,
        /;\s*Secure/i,
        /;\s*SameSite=Lax/i,
        /;\s*Max-Age=7776000/i,
      ]) {
        expect(attribute.test(line), String(attribute)).toBe(true);
      }
      expect(/;\s*Domain=/i.test(line)).toBe(false);
      // a wrong password sets nothing
      const wrong = await signIn(stack.client(), email, strongPassword());
      expect(wrong.setCookie.some((l) => /known_device/.test(l))).toBe(false);
    });

    it('51 wrong passwords from 51 addresses do NOT lock the owner out: the known device still signs in, anyone else is throttled', async () => {
      const email = uniqueEmail('flood');
      const password = strongPassword();
      const owner = await verifiedUser(stack, email, password, expect);
      const known = deviceJar(owner);
      expect(Object.keys(known)).toHaveLength(1);

      // The reviewer's attack: one wrong guess from each of 51 addresses, in parallel (~5 s of delay).
      const guesses = await Promise.all(
        Array.from({ length: 51 }, (_, i) =>
          signIn(
            stack.client({ ip: `198.18.${Math.floor(i / 200)}.${(i % 200) + 1}` }),
            email,
            strongPassword(),
          ),
        ),
      );
      expect(guesses.filter((r) => r.status === 429).length).toBeGreaterThan(0); // the ceiling was reached

      // The owner, from a NEW address, carrying the known-device cookie: in.
      const returning = stack.client({ ip: '198.51.100.150' });
      returning.setCookies(known);
      expect((await signIn(returning, email, password)).status).toBe(200);

      // The same owner WITHOUT the cookie, from another new address: still throttled.
      // (The success above bumped the generation; reach the ceiling again to test the unknown path.)
      await stack.seedCounter(
        lockoutKeys.account('signin', await generation(email), email),
        DEFAULTS.lockout.perAccount.ceiling,
        3600,
      );
      const stranger = await signIn(stack.client({ ip: '198.51.100.151' }), email, password);
      expect(stranger.status).toBe(429);
      expect(stranger.json()).toMatchObject({ code: 'ACCOUNT_LOCKED' });
    }, 60_000);

    it('a known-device cookie of ANOTHER account, or a forged one, is no cookie at all', async () => {
      const email = uniqueEmail('target');
      const password = strongPassword();
      await verifiedUser(stack, email, password, expect);
      const other = await verifiedUser(stack, uniqueEmail('other'), strongPassword(), expect);
      await stack.seedCounter(
        lockoutKeys.account('signin', await generation(email), email),
        DEFAULTS.lockout.perAccount.ceiling,
        3600,
      );
      const withOthers = stack.client({ ip: '198.51.100.160' });
      withOthers.setCookies(deviceJar(other));
      expect((await signIn(withOthers, email, password)).status).toBe(429);

      const [name, value] = Object.entries(deviceJar(other))[0]!;
      const forged = stack.client({ ip: '198.51.100.161' });
      forged.setCookies({ [name]: `${value.slice(0, -3)}AAA` });
      expect((await signIn(forged, email, password)).status).toBe(429);
    });

    it('a known device is still limited per device: 5 failures in 15 minutes', async () => {
      const email = uniqueEmail('devlimit');
      const password = strongPassword();
      const owner = await verifiedUser(stack, email, password, expect);
      const jar = deviceJar(owner);
      const deviceId = decodeURIComponent(Object.values(jar)[0]!).split('.')[0]!.split(':')[1]!;
      await stack.seedCounter(
        lockoutKeys.device('signin', await generation(email), email, deviceId),
        DEFAULTS.lockout.knownDevice.maxAttempts,
      );
      const again = stack.client({ ip: '198.51.100.170' });
      again.setCookies(jar);
      const locked = await signIn(again, email, password);
      expect(locked.status).toBe(429);
      expect(locked.json()).toMatchObject({ code: 'ACCOUNT_LOCKED' });
    });

    it('2FA verification has the same known-device rule', async () => {
      const email = uniqueEmail('mfadevice');
      const password = strongPassword();
      const c = await verifiedUser(stack, email, password, expect);
      const enable = await c.post(`${API}/two-factor/enable`, { password });
      const secret = new URL(enable.json<{ totpURI: string }>().totpURI).searchParams.get(
        'secret',
      )!;
      expect((await c.post(`${API}/two-factor/verify-totp`, { code: totp(secret) })).status).toBe(
        200,
      );
      await c.post(`${API}/sign-out`, {});
      const userId = (
        await stack.pool.query<{ id: string }>(`select id from identity."user" where email = $1`, [
          email,
        ])
      ).rows[0]!.id;

      // Sign in again from the owner's browser (cookie jar kept): a second factor is asked for.
      const browser = stack.client({ ip: '198.51.100.180' });
      browser.setCookies(deviceJar(c));
      const challenge = await signIn(browser, email, password);
      expect(challenge.json()).toMatchObject({ twoFactorRedirect: true });
      // ...the account-wide ceiling is exhausted by someone else...
      await stack.seedCounter(
        lockoutKeys.account('2fa', await generation(userId), userId),
        DEFAULTS.lockout.perAccount.ceiling,
        3600,
      );
      // ...a stranger holding the same pending challenge is throttled, the known device is not.
      const stranger = stack.client({ ip: '198.51.100.181' });
      stranger.setCookies(
        Object.fromEntries(
          Object.entries(browser.cookies).filter(([n]) => !n.endsWith('.known_device')),
        ),
      );
      expect(
        (await stranger.post(`${API}/two-factor/verify-totp`, { code: totp(secret) })).status,
      ).toBe(429);
      expect(
        (await browser.post(`${API}/two-factor/verify-totp`, { code: totp(secret) })).status,
      ).toBe(200);
    });

    it('a successful sign-in clears the counters', async () => {
      const email = uniqueEmail('clear');
      const password = strongPassword();
      await verifiedUser(stack, email, password, expect);
      await stack.seedCounter(
        lockoutKeys.account('signin', await generation(email), email),
        20,
        3600,
      );
      expect((await signIn(stack.client({ ip: '198.51.100.40' }), email, password)).status).toBe(
        200,
      );
      // The counters moved to a new generation: the 21 stays behind, and counting restarts from 1.
      const now = await generation(email);
      expect(now).toBeGreaterThan(0);
      expect(await stack.get(lockoutKeys.account('signin', now - 1, email))).toBe('21');
      expect(await stack.get(lockoutKeys.account('signin', now, email))).toBeNull();
      await signIn(stack.client({ ip: '198.51.100.41' }), email, strongPassword());
      expect(await stack.get(lockoutKeys.account('signin', now, email))).toBe('1');
    });

    it('a successful password reset clears the counters, including an address that was locked out', async () => {
      const email = uniqueEmail('resetclear');
      const oldPassword = strongPassword();
      const newPassword = strongPassword();
      await verifiedUser(stack, email, oldPassword, expect);
      const ip = '203.0.113.50';
      await stack.seedCounter(
        lockoutKeys.accountAndIp('signin', await generation(email), email, ip),
        DEFAULTS.lockout.perAccountAndIp.maxAttempts,
      );
      expect((await signIn(stack.client({ ip }), email, oldPassword)).status).toBe(429);

      const anon = stack.client();
      await anon.post(`${API}/request-password-reset`, { email, redirectTo: '/r' });
      const mail = (await stack.mail()).filter(
        (m) => m.to === email && m.category === 'auth.reset-password',
      );
      const token = new URL(mail.at(-1)!.text).pathname.split('/').pop()!;
      expect((await anon.post(`${API}/reset-password`, { token, newPassword })).status).toBe(200);

      expect((await signIn(stack.client({ ip }), email, newPassword)).status).toBe(200);
    });

    it('answers sign-up, sign-in and reset identically for known and unknown addresses', async () => {
      const email = uniqueEmail('enum');
      const password = strongPassword();
      await verifiedUser(stack, email, password, expect);
      const c = stack.client();
      const dup = await c.post(`${API}/sign-up/email`, { email, password, name: 'd' });
      const fresh = await stack
        .client()
        .post(`${API}/sign-up/email`, { email: uniqueEmail('fresh'), password, name: 'd' });
      expect(dup.status).toBe(fresh.status);
      expect(Object.keys(dup.json()).sort()).toEqual(Object.keys(fresh.json()).sort());
      const unknown = await signIn(stack.client(), uniqueEmail('nobody'), password);
      const wrong = await signIn(stack.client(), email, strongPassword());
      expect(unknown.status).toBe(wrong.status);
      expect(unknown.json()).toEqual(wrong.json());
      const known = await stack
        .client()
        .post(`${API}/request-password-reset`, { email, redirectTo: '/r' });
      const ghost = await stack
        .client()
        .post(`${API}/request-password-reset`, { email: uniqueEmail('zz'), redirectTo: '/r' });
      expect(known.status).toBe(ghost.status);
      expect(known.json()).toEqual(ghost.json());
    });

    it('takes the same time for a known and an unknown address on reset (timing floor)', async () => {
      const email = uniqueEmail('timing');
      await verifiedUser(stack, email, strongPassword(), expect);
      const time = async (address: string): Promise<number> => {
        const started = performance.now();
        await stack
          .client()
          .post(`${API}/request-password-reset`, { email: address, redirectTo: '/r' });
        return performance.now() - started;
      };
      const known: number[] = [];
      const unknown: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        known.push(await time(email));
        unknown.push(await time(uniqueEmail('ghost')));
      }
      const floor = DEFAULTS.timingFloorMs - 5;
      expect(Math.min(...known)).toBeGreaterThanOrEqual(floor);
      expect(Math.min(...unknown)).toBeGreaterThanOrEqual(floor);
    });
  });
}

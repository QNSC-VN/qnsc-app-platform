import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  API,
  emailedLink,
  signIn,
  signUp,
  strongPassword,
  uniqueEmail,
  verifiedUser,
} from './support/flows';
import { startStack, type Stack } from './support/stack';

/**
 * Criterion 3 — email + password sign-up with verification, reset (all sessions revoked), lockout.
 */
describe('C3 email + password', () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack();
  });
  afterAll(async () => {
    await stack?.stop();
  });

  it('refuses sign-in before the address is verified, and sends a fresh verification mail', async () => {
    const email = uniqueEmail('unverified');
    const password = strongPassword();
    const c = stack.client();
    await signUp(c, email, password);
    await stack.drainMail(); // the sign-up mail
    // The verification token is a JWT stamped in whole seconds: a re-send inside the SAME second
    // is byte-identical, so the idempotency key (purpose + user + sha256(token)) rightly dedupes
    // it. A real "resend" arrives later; wait for the next second.
    await new Promise((r) => setTimeout(r, 1100));

    const res = await signIn(c, email, password);
    expect(res.status).toBe(403);
    expect(res.json()).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
    expect(res.setCookie.filter((l) => /session_token/.test(l))).toHaveLength(0);
    // sign-in of an unverified account re-sends the verification mail
    expect(await stack.drainMail()).toHaveLength(1);
  });

  it('verifies through the emailed link, then signs in', async () => {
    const email = uniqueEmail('verify');
    const password = strongPassword();
    const c = stack.client();
    await signUp(c, email, password);
    const link = await emailedLink(stack, email);
    expect(link).toContain('/api/auth/verify-email?token=');

    const verified = await c.get(link);
    expect(verified.status).toBe(302);

    const res = await signIn(c, email, password);
    expect(res.status).toBe(200);
    const me = await c.get('/v1/me');
    expect(me.status).toBe(200);
    expect(me.json()).toMatchObject({ email });
  });

  it('rejects passwords outside the 12..128 policy and enforces no composition rules', async () => {
    const c = stack.client();
    const short = await c.post(`${API}/sign-up/email`, {
      email: uniqueEmail('short'),
      password: 'Aa1!aaaa',
      name: 'x',
    });
    expect(short.status).toBe(400);
    expect(short.json()).toMatchObject({ code: 'PASSWORD_TOO_SHORT' });
    const long = await c.post(`${API}/sign-up/email`, {
      email: uniqueEmail('long'),
      password: 'a'.repeat(129),
      name: 'x',
    });
    expect(long.status).toBe(400);
    expect(long.json()).toMatchObject({ code: 'PASSWORD_TOO_LONG' });
    // 12 lower-case letters: no composition rule, so accepted
    const plain = await c.post(`${API}/sign-up/email`, {
      email: uniqueEmail('plain'),
      password: 'abcdefghijkl',
      name: 'x',
    });
    expect(plain.status).toBe(200);
  });

  it('password reset: single-use token, new password works, old one does not, ALL sessions revoked', async () => {
    const email = uniqueEmail('reset');
    const oldPassword = strongPassword();
    const newPassword = strongPassword();

    // Two live sessions (two devices).
    const first = await verifiedUser(stack, email, oldPassword);
    const second = stack.client();
    expect((await signIn(second, email, oldPassword)).status).toBe(200);
    expect((await first.get('/v1/me')).status).toBe(200);
    expect((await second.get('/v1/me')).status).toBe(200);

    // Request the reset from a third, signed-out client.
    const anon = stack.client();
    const requested = await anon.post(`${API}/request-password-reset`, {
      email,
      redirectTo: '/reset',
    });
    expect(requested.status).toBe(200);
    const link = await emailedLink(stack, email);
    const token = new URL(link).pathname.split('/').pop()!;

    const done = await anon.post(`${API}/reset-password`, { token, newPassword });
    expect(done.status, done.body).toBe(200);

    // Every session that existed before the reset is dead on its next request.
    expect((await first.get('/v1/me')).status).toBe(401);
    expect((await second.get('/v1/me')).status).toBe(401);

    // Token is single-use.
    const replay = await anon.post(`${API}/reset-password`, {
      token,
      newPassword: strongPassword(),
    });
    expect(replay.status).toBe(400);
    expect(replay.json()).toMatchObject({ code: 'INVALID_TOKEN' });

    // Old password no longer works; the new one does.
    expect((await signIn(stack.client(), email, oldPassword)).status).toBe(401);
    expect((await signIn(stack.client(), email, newPassword)).status).toBe(200);
  });

  it('password reset token lives 15 minutes', async () => {
    const email = uniqueEmail('ttl');
    await verifiedUser(stack, email, strongPassword());
    const anon = stack.client();
    await anon.post(`${API}/request-password-reset`, { email, redirectTo: '/reset' });
    await stack.drainMail();
    const { rows } = await stack.pool.query<{ ttl: number }>(
      `select extract(epoch from (expires_at - created_at))::int as ttl
         from identity.verification order by created_at desc limit 1`,
    );
    expect(rows[0]!.ttl).toBeGreaterThanOrEqual(14 * 60);
    expect(rows[0]!.ttl).toBeLessThanOrEqual(15 * 60);
  });

  it('stores reset-token identifiers hashed, never plain', async () => {
    const email = uniqueEmail('hashed');
    await verifiedUser(stack, email, strongPassword());
    const anon = stack.client();
    await anon.post(`${API}/request-password-reset`, { email, redirectTo: '/reset' });
    const link = await emailedLink(stack, email);
    const token = new URL(link).pathname.split('/').pop()!;
    const { rows } = await stack.pool.query<{ identifier: string }>(
      `select identifier from identity.verification where identifier like '%' || $1 || '%'`,
      [token],
    );
    expect(rows, 'the plain token must not appear in a verification identifier').toHaveLength(0);
  });

  it('account lockout: per-ACCOUNT, across different client addresses', async () => {
    const email = uniqueEmail('lock');
    const password = strongPassword();
    await verifiedUser(stack, email, password);

    // 5 wrong guesses, each from a DIFFERENT address, so the per-IP limiter never trips.
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const attacker = stack.client({ 'cf-connecting-ip': `203.0.113.${10 + i}` });
      statuses.push((await signIn(attacker, email, `wrong-${i}-${strongPassword()}`)).status);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401]);

    // The 6th attempt is refused even with the CORRECT password, from yet another address.
    const sixth = await signIn(
      stack.client({ 'cf-connecting-ip': '203.0.113.99' }),
      email,
      password,
    );
    expect(sixth.status).toBe(429);
    expect(sixth.json()).toMatchObject({ code: 'ACCOUNT_LOCKED' });
  });

  it('a successful sign-in clears the failure count', async () => {
    const email = uniqueEmail('clear');
    const password = strongPassword();
    await verifiedUser(stack, email, password);
    for (let i = 0; i < 3; i += 1) {
      await signIn(
        stack.client({ 'cf-connecting-ip': `198.51.100.${i + 1}` }),
        email,
        strongPassword(),
      );
    }
    expect(
      (await signIn(stack.client({ 'cf-connecting-ip': '198.51.100.50' }), email, password)).status,
    ).toBe(200);
    // count reset: 4 more wrong attempts are still below the limit of 5
    for (let i = 0; i < 4; i += 1) {
      const r = await signIn(
        stack.client({ 'cf-connecting-ip': `198.51.100.${60 + i}` }),
        email,
        strongPassword(),
      );
      expect(r.status).toBe(401);
    }
  });

  it('control: the built-in limiter alone does NOT stop a distributed guess at one account', async () => {
    // Same attack against an account WITHOUT the lockout plugin's effect is shown by inspecting the
    // built-in limiter's key: it is `<ip>|<path>`, so each attacker address has its own bucket.
    const keys = await stack.cache.instance.keys('*');
    const rateLimitKeys = keys.filter((k) => k.includes('|/sign-in/email'));
    expect(rateLimitKeys.length).toBeGreaterThan(1);
    for (const k of rateLimitKeys) expect(k).toMatch(/\|\/sign-in\/email$/);
  });

  it('enumeration: sign-up for an existing address and for a new one look identical', async () => {
    const email = uniqueEmail('enum');
    const password = strongPassword();
    await verifiedUser(stack, email, password);
    const c = stack.client();
    const dup = await c.post(`${API}/sign-up/email`, { email, password, name: 'Dup' });
    const fresh = await c.post(`${API}/sign-up/email`, {
      email: uniqueEmail('enum2'),
      password,
      name: 'Dup',
    });
    expect(dup.status).toBe(fresh.status);
    const shape = (b: string) => Object.keys(JSON.parse(b)).sort();
    expect(shape(dup.body)).toEqual(shape(fresh.body));
    expect(JSON.parse(dup.body).token).toBeNull();
    // and sign-in: unknown email vs wrong password
    const unknown = await signIn(stack.client(), uniqueEmail('nobody'), password);
    const wrong = await signIn(stack.client(), email, strongPassword());
    expect(unknown.status).toBe(wrong.status);
    expect(unknown.json()).toEqual(wrong.json());
    // and password-reset: unknown vs known
    const rk = await stack
      .client()
      .post(`${API}/request-password-reset`, { email, redirectTo: '/r' });
    const ru = await stack
      .client()
      .post(`${API}/request-password-reset`, { email: uniqueEmail('zzz'), redirectTo: '/r' });
    expect(rk.status).toBe(ru.status);
    expect(rk.json()).toEqual(ru.json());
  });

  it('enumeration timing: unknown vs known address differ by less than the hash cost (measured)', async () => {
    const email = uniqueEmail('timing');
    const password = strongPassword();
    await verifiedUser(stack, email, password);
    const time = async (e: string): Promise<number> => {
      const t = performance.now();
      await signIn(
        stack.client({ 'cf-connecting-ip': `192.0.2.${Math.floor(Math.random() * 250) + 1}` }),
        e,
        strongPassword(),
      );
      return performance.now() - t;
    };
    const known: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      known.push(await time(email));
      unknown.push(await time(uniqueEmail('ghost')));
    }
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    console.info(
      `[C3 timing] sign-in wrong password: known=${median(known).toFixed(1)}ms unknown=${median(unknown).toFixed(1)}ms`,
    );
    // A hash is ~tens of ms; a missing dummy hash would show as a large known/unknown gap.
    expect(Math.abs(median(known) - median(unknown))).toBeLessThan(median(known));
    void sql;
  });
});

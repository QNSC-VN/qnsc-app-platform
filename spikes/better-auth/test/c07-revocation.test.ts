import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API, signIn, strongPassword, uniqueEmail, verifiedUser } from './support/flows';
import { startStack, type Stack } from './support/stack';
import type { Client } from './support/client';

/**
 * Criterion 7 — session revocation takes effect on the next request with the cookie cache OFF.
 */
async function adminOf(stack: Stack): Promise<Client> {
  const email = uniqueEmail('admin');
  const password = strongPassword();
  await verifiedUser(stack, email, password);
  await stack.pool.query(`update identity."user" set role = 'admin' where email = $1`, [email]);
  const c = stack.client();
  expect((await signIn(c, email, password)).status).toBe(200);
  return c;
}

describe('C7 revocation, cookie cache OFF (the default and the staff setting)', () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack();
  });
  afterAll(async () => {
    await stack?.stop();
  });

  it('sign-out kills that session on the very next request', async () => {
    const c = await verifiedUser(stack, uniqueEmail('out'), strongPassword());
    expect((await c.get('/v1/me')).status).toBe(200);
    const stale = { ...c.cookies };
    expect((await c.post(`${API}/sign-out`, {})).status).toBe(200);
    const replay = stack.client();
    replay.setCookies(stale);
    expect((await replay.get('/v1/me')).status).toBe(401);
  });

  it('"sign out everywhere" revokes every device', async () => {
    const email = uniqueEmail('all');
    const password = strongPassword();
    const a = await verifiedUser(stack, email, password);
    const b = stack.client();
    await signIn(b, email, password);
    expect((await b.get('/v1/me')).status).toBe(200);
    expect((await a.post(`${API}/revoke-sessions`, {})).status).toBe(200);
    expect((await a.get('/v1/me')).status).toBe(401);
    expect((await b.get('/v1/me')).status).toBe(401);
  });

  it('revoking ONE other session (by token) leaves the caller signed in', async () => {
    const email = uniqueEmail('one');
    const password = strongPassword();
    const a = await verifiedUser(stack, email, password);
    const b = stack.client();
    const signed = await signIn(b, email, password);
    const otherToken = signed.json<{ token: string }>().token;
    expect((await a.post(`${API}/revoke-session`, { token: otherToken })).status).toBe(200);
    expect((await b.get('/v1/me')).status).toBe(401);
    expect((await a.get('/v1/me')).status).toBe(200);
  });

  it("offboarding: an admin revoking a user's sessions is effective on their next request", async () => {
    const admin = await adminOf(stack);
    const email = uniqueEmail('victim');
    const password = strongPassword();
    const victim = await verifiedUser(stack, email, password);
    const { rows } = await stack.pool.query<{ id: string }>(
      `select id from identity."user" where email = $1`,
      [email],
    );
    expect((await victim.get('/v1/me')).status).toBe(200);
    const res = await admin.post(`${API}/admin/revoke-user-sessions`, { userId: rows[0]!.id });
    expect(res.status, res.body).toBe(200);
    expect((await victim.get('/v1/me')).status).toBe(401);
  });

  it('offboarding: banning a user revokes sessions AND blocks sign-in', async () => {
    const admin = await adminOf(stack);
    const email = uniqueEmail('banned');
    const password = strongPassword();
    const victim = await verifiedUser(stack, email, password);
    const { rows } = await stack.pool.query<{ id: string }>(
      `select id from identity."user" where email = $1`,
      [email],
    );
    const res = await admin.post(`${API}/admin/ban-user`, {
      userId: rows[0]!.id,
      banReason: 'offboarded',
    });
    expect(res.status, res.body).toBe(200);
    expect((await victim.get('/v1/me')).status).toBe(401);
    const again = await signIn(stack.client(), email, password);
    expect(again.status).toBe(403);
    expect(again.json()).toMatchObject({ code: 'BANNED_USER' });
  });

  it("a non-admin cannot revoke someone else's sessions", async () => {
    const attacker = await verifiedUser(stack, uniqueEmail('att'), strongPassword());
    const victimEmail = uniqueEmail('vic');
    const victim = await verifiedUser(stack, victimEmail, strongPassword());
    const { rows } = await stack.pool.query<{ id: string }>(
      `select id from identity."user" where email = $1`,
      [victimEmail],
    );
    const res = await attacker.post(`${API}/admin/revoke-user-sessions`, { userId: rows[0]!.id });
    expect(res.status).toBe(403);
    expect((await victim.get('/v1/me')).status).toBe(200);
  });

  it('presets decide the lifetime: public 7 days, staff-only 12 hours', async () => {
    const pub = await verifiedUser(stack, uniqueEmail('life'), strongPassword());
    expect((await pub.get('/v1/me')).status).toBe(200);
    const { rows: p } = await stack.pool.query<{ secs: number }>(
      `select extract(epoch from (expires_at - created_at))::int as secs from identity.session order by created_at desc limit 1`,
    );
    expect(p[0]!.secs).toBeGreaterThanOrEqual(7 * 86400 - 5);
    expect(p[0]!.secs).toBeLessThanOrEqual(7 * 86400 + 5);

    // staff-only preset: no password sign-in at all, so seed a session directly through the API.
    const staff = await startStack({ identity: { presets: ['staff'] } });
    try {
      expect(staff.auth.options.session?.expiresIn).toBe(12 * 3600);
      expect(staff.auth.options.session?.cookieCache?.enabled).toBe(false);
      expect(staff.auth.options.emailAndPassword?.enabled).toBe(false);
      const res = await staff.client().post(`${API}/sign-up/email`, {
        email: uniqueEmail('nope'),
        password: strongPassword(),
        name: 'x',
      });
      expect(res.status).toBe(400);
      expect(res.json()).toMatchObject({ code: 'EMAIL_PASSWORD_SIGN_UP_DISABLED' });
      const si = await staff
        .client()
        .post(`${API}/sign-in/email`, { email: uniqueEmail('nope'), password: strongPassword() });
      expect(si.status).toBe(400);
      expect(si.json()).toMatchObject({ code: 'EMAIL_PASSWORD_DISABLED' });
    } finally {
      await staff.stop();
    }
  });
});

describe('C7 control: cookie cache ON leaves a revocation window', () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack({ identity: { spike: { cookieCache: true } } });
  });
  afterAll(async () => {
    await stack?.stop();
  });

  it('after revoke-sessions the OLD cookie is still accepted until the cache expires (5 min here)', async () => {
    const email = uniqueEmail('stale');
    const password = strongPassword();
    const a = await verifiedUser(stack, email, password);
    expect((await a.get('/v1/me')).status).toBe(200); // primes the cookie cache
    const stale = { ...a.cookies };
    expect(Object.keys(stale).length).toBeGreaterThanOrEqual(2); // token + session_data

    const b = stack.client();
    await signIn(b, email, password);
    expect((await b.post(`${API}/revoke-sessions`, {})).status).toBe(200);

    const replay = stack.client();
    replay.setCookies(stale);
    const res = await replay.get('/v1/me');
    // The signed cookie cache is believed without asking Valkey or Postgres: the window is real.
    expect(res.status).toBe(200);
  });
});

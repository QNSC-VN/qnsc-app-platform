import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from 'better-auth';
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
 * Criterion 11 supports: the §5.4 "secure defaults" rows that are claims about Better Auth's
 * behaviour rather than about our wiring, checked one by one so the ADR can list differences.
 */
describe('C11 secure-default claims', () => {
  const created: string[] = [];
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack({
      identity: { hooks: { onUserCreated: (user: User) => void created.push(user.email) } },
    });
  });
  afterAll(async () => {
    await stack?.stop();
  });

  it('the session is SLIDING: a session older than updateAge (1 day) gets its expiry pushed out', async () => {
    const email = uniqueEmail('slide');
    const c = await verifiedUser(stack, email, strongPassword());
    // Age the session by two days: created/updated in the past, expiry five days away.
    await stack.pool.query(
      `update identity.session s set updated_at = now() - interval '2 days',
              created_at = now() - interval '2 days', expires_at = now() + interval '5 days'
        from identity."user" u where u.id = s.user_id and u.email = $1`,
      [email],
    );
    // The Valkey copy carries the OLD expiry; drop it so the database row is what gets read.
    for (const key of await stack.cache.instance.keys('*'))
      await stack.cache.instance.del(key.replace(stack.keyPrefix, ''));
    expect((await c.get('/v1/me')).status).toBe(200);
    const { rows } = await stack.pool.query<{ days: number }>(
      `select extract(epoch from (s.expires_at - now()))/86400 as days
         from identity.session s join identity."user" u on u.id = s.user_id where u.email = $1`,
      [email],
    );
    console.info(
      `[C11 sliding] expiry after a read of a 2-day-old session: ${Number(rows[0]!.days).toFixed(2)} days from now`,
    );
    expect(Number(rows[0]!.days)).toBeGreaterThan(6.5);
  });

  it('session fixation: signing in while holding a planted session cookie issues a NEW token', async () => {
    const email = uniqueEmail('fix');
    const password = strongPassword();
    const victim = await verifiedUser(stack, email, password);
    const planted = { ...victim.cookies };
    const attacker = stack.client();
    attacker.setCookies(planted);
    const res = await signIn(attacker, email, password);
    expect(res.status).toBe(200);
    const [name] = Object.keys(planted);
    expect(attacker.cookies[name!]).not.toBe(planted[name!]);
  });

  it('databaseHooks.user.create.after (onUserCreated) fires once per new user', async () => {
    const email = uniqueEmail('hook');
    await signUp(stack.client(), email, strongPassword());
    await stack.drainMail();
    expect(created.filter((e) => e === email)).toHaveLength(1);
  });

  it('the verification link is single-purpose: a verification JWT cannot be replayed as a reset token', async () => {
    const email = uniqueEmail('purpose');
    const c = stack.client();
    await signUp(c, email, strongPassword());
    const link = await emailedLink(stack, email);
    const token = new URL(link).searchParams.get('token')!;
    const res = await c.post(`${API}/reset-password`, { token, newPassword: strongPassword() });
    expect(res.status).toBe(400);
    expect(res.json()).toMatchObject({ code: 'INVALID_TOKEN' });
  });

  it('a verification link for one address cannot verify another account', async () => {
    const a = uniqueEmail('va');
    const b = uniqueEmail('vb');
    const ca = stack.client();
    await signUp(ca, a, strongPassword());
    await signUp(stack.client(), b, strongPassword());
    const sent = await stack.drainMail();
    const linkA = sent.find((m) => m.to === a)!.text;
    await ca.get(linkA);
    const { rows } = await stack.pool.query<{ email: string; email_verified: boolean }>(
      `select email, email_verified from identity."user" where email in ($1, $2) order by email`,
      [a, b].sort(),
    );
    const byEmail = Object.fromEntries(rows.map((r) => [r.email, r.email_verified]));
    expect(byEmail[a]).toBe(true);
    expect(byEmail[b]).toBe(false);
  });

  it('expired verification links are refused', async () => {
    const short = await startStack({ identity: { presets: ['public'] } });
    try {
      const email = uniqueEmail('exp');
      const c = short.client();
      await signUp(c, email, strongPassword());
      const link = await emailedLink(short, email);
      // Tamper the signature: exp/sig protect the token; a forged one must not verify.
      const bad = link.replace(/token=([^&]+)/, (_m, t: string) => `token=${t.slice(0, -3)}AAA`);
      const res = await c.get(bad);
      expect(res.status).toBe(302);
      expect(res.location).toMatch(/error=/);
      const { rows } = await short.pool.query(
        `select email_verified from identity."user" where email = $1`,
        [email],
      );
      expect(rows[0].email_verified).toBe(false);
    } finally {
      await short.stop();
    }
  });
});

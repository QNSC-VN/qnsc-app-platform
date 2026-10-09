import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CacheService } from '@quynhonsemiconductor/platform-cache';
import { createIdentity } from '../src/identity/create-identity';
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
 * Criterion 4 — `auth.handler` mounted on Fastify inside NestJS; global guard via
 * `auth.api.getSession`.
 */
describe('C4 Fastify mount + global SessionGuard', () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack();
  });
  afterAll(async () => {
    await stack?.stop();
  });

  it('every route is protected unless @Public(); the platform-http envelope renders the 401', async () => {
    const c = stack.client();
    expect((await c.get('/v1/public')).status).toBe(200);
    const denied = await c.get('/v1/me');
    expect(denied.status).toBe(401);
    expect(denied.json()).toEqual({
      error: {
        code: 'AUTH_UNAUTHENTICATED',
        message: 'Sign in required',
        details: [],
        correlationId: 'spike',
      },
    });
  });

  it('the guard resolves the cookie the handler set, through auth.api.getSession', async () => {
    const email = uniqueEmail('guard');
    const c = await verifiedUser(stack, email, strongPassword());
    const me = await c.get('/v1/me');
    expect(me.status).toBe(200);
    expect(me.json()).toMatchObject({ email });
  });

  it('a forged or truncated cookie is a 401, not a 500', async () => {
    const c = stack.client();
    const real = await verifiedUser(stack, uniqueEmail('forge'), strongPassword());
    const [name, value] = Object.entries(real.cookies)[0]!;
    c.setCookies({ [name]: `${value.slice(0, -4)}AAAA` });
    expect((await c.get('/v1/me')).status).toBe(401);
    c.setCookies({ [name]: 'garbage' });
    expect((await c.get('/v1/me')).status).toBe(401);
  });

  it('the body reaches Better Auth un-parsed: JSON and application/x-www-form-urlencoded both work', async () => {
    const c = stack.client();
    const email = uniqueEmail('form');
    const password = strongPassword();
    const json = await c.post(`${API}/sign-up/email`, { email, password, name: 'J' });
    expect(json.status).toBe(200);
    // Fastify has NO form parser: on a root-registered route this is a 415 before the handler runs.
    const form = await c.request('POST', `${API}/sign-in/email`, { form: { email, password } });
    expect(form.status).not.toBe(415);
    // 403 EMAIL_NOT_VERIFIED means the form body was read and the credentials checked.
    expect(form.json()).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
  });

  it('why the mount is encapsulated: a bare Fastify route answers a form POST with 415', async () => {
    const bare = Fastify();
    bare.post('/auth', async () => 'ok');
    const res = await bare.inject({
      method: 'POST',
      url: '/auth',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'a=1',
    });
    expect(res.statusCode).toBe(415);
    await bare.close();
  });

  it('control: the same form POST to a NON-auth Nest route is still Fastify-default (415)', async () => {
    const c = stack.client();
    const res = await c.request('POST', '/v1/public', { form: { a: '1' } });
    expect([404, 415]).toContain(res.status); // the mount's parsers are encapsulated
  });

  it('repeated Set-Cookie headers survive the Response -> reply copy', async () => {
    const c = stack.client();
    const email = uniqueEmail('cookies');
    const password = strongPassword();
    await signUp(c, email, password);
    // verify, then sign in; with the cookie cache ON two cookies are set (token + data)
    const cached = await startStack({ identity: { spike: { cookieCache: true } } });
    try {
      const cc = cached.client();
      const e2 = uniqueEmail('cookies2');
      const pw = strongPassword();
      await signUp(cc, e2, pw);
      await cc.get(await emailedLink(cached, e2));
      const res = await signIn(cc, e2, pw);
      expect(res.status).toBe(200);
      const names = res.setCookie.map((l) => l.split('=')[0]);
      expect(names.length).toBeGreaterThanOrEqual(2);
      expect(new Set(names).size).toBe(names.length);
    } finally {
      await cached.stop();
    }
  });

  it('cookie attributes: HttpOnly, Secure, SameSite=Lax, host-only, __Secure- prefix', async () => {
    const c = stack.client();
    const email = uniqueEmail('attrs');
    const password = strongPassword();
    await signUp(c, email, password);
    await c.get(await emailedLink(stack, email));
    const res = await signIn(c, email, password);
    const line = res.setCookie.find((l) => /session_token/.test(l))!;
    expect(line.split('=')[0]).toBe('__Secure-spike.session_token');
    expect(line).toMatch(/;\s*HttpOnly/i);
    expect(line).toMatch(/;\s*Secure/i);
    expect(line).toMatch(/;\s*SameSite=Lax/i);
    expect(line).toMatch(/;\s*Path=\//i);
    expect(line).not.toMatch(/;\s*Domain=/i); // host-only
    expect(line).toMatch(/;\s*Max-Age=604800/i); // 7 days, the public preset
  });

  it('CSRF: with a session cookie present, a state-changing request from an untrusted Origin is refused', async () => {
    const real = await verifiedUser(stack, uniqueEmail('csrf'), strongPassword());
    const attacker = stack.client({ origin: 'https://evil.example' });
    attacker.setCookies(real.cookies);
    const res = await attacker.post(`${API}/sign-out`, {});
    expect(res.status).toBe(403);
    expect(res.json()).toMatchObject({ code: 'INVALID_ORIGIN' });
    expect((await real.get('/v1/me')).status).toBe(200); // the session survived
  });

  it('CSRF: a cookie-less state-changing POST from an untrusted Origin is refused too', async () => {
    const evil = stack.client({ origin: 'https://evil.example' });
    const res = await evil.post(`${API}/sign-in/email`, {
      email: uniqueEmail('x'),
      password: strongPassword(),
    });
    expect(res.status).toBe(403);
  });

  it('TRAP: with NODE_ENV=test and no explicit flag, Better Auth would skip the origin check', async () => {
    // `core/env isTest()` is `NODE_ENV === 'test' || TEST`; `skipOriginCheck` defaults to it.
    // createIdentity pins `disableOriginCheck: false`, so the two tests above hold even under
    // vitest (NODE_ENV=test). Asserting the trap exists keeps the reason for the pin visible.
    expect(process.env['NODE_ENV']).toBe('test');
  });

  it('open redirect: callbackURL outside trustedOrigins is refused', async () => {
    const c = stack.client();
    const res = await c.post(`${API}/request-password-reset`, {
      email: uniqueEmail('r'),
      redirectTo: 'https://evil.example/steal',
    });
    expect(res.status).toBe(403);
    expect(res.json()).toMatchObject({ code: 'INVALID_REDIRECT_URL' });
  });

  it('refuses to be built without trustedOrigins', () => {
    expect(() =>
      createIdentity({
        product: 'spike',
        db: {},
        schema: {},
        cache: new CacheService({ mode: 'optional' }),
        baseURL: 'http://127.0.0.1',
        secret: 'x'.repeat(32),
        trustedOrigins: [],
        presets: ['public'],
        email: {
          sendVerification: async () => undefined,
          sendPasswordReset: async () => undefined,
        },
      }),
    ).toThrow(/trustedOrigins/);
  });
});

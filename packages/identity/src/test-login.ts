import { createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import type { BetterAuthPlugin } from 'better-auth';
import * as z from 'zod';

export const TEST_LOGIN_ENV = 'IDENTITY_TEST_LOGIN';

export class TestLoginRefusedError extends Error {
  constructor(reason: string) {
    super(`test-login refused: ${reason}`);
    this.name = 'TestLoginRefusedError';
  }
}

/**
 * Identity plan D17, tightened by review S7. The passwordless sign-in used by end-to-end suites loads
 * ONLY when ALL of these hold: the product asked for it (`testLogin: true`), `IDENTITY_TEST_LOGIN` is
 * exactly `enabled`, and `NODE_ENV` is exactly `test` or `development`. An unset or unknown `NODE_ENV`
 * (`staging`, `prod`, a typo) is NOT a licence: the allow-list is closed, not "anything but production".
 * Asking for it otherwise throws at start-up, so a misconfigured pod does not boot with a back door.
 */
const TEST_LOGIN_ENVIRONMENTS = new Set(['test', 'development']);

export function assertTestLoginAllowed(env: NodeJS.ProcessEnv): void {
  if (!TEST_LOGIN_ENVIRONMENTS.has(env['NODE_ENV'] ?? '')) {
    throw new TestLoginRefusedError('NODE_ENV must be "test" or "development"');
  }
  if (env[TEST_LOGIN_ENV] !== 'enabled')
    throw new TestLoginRefusedError(`${TEST_LOGIN_ENV} is not "enabled"`);
}

/** `POST /test-login { email }`: find or create that verified user and start a session. */
export function testLogin(env: NodeJS.ProcessEnv): BetterAuthPlugin {
  assertTestLoginAllowed(env);
  return {
    id: 'qnsc-test-login',
    endpoints: {
      testLogin: createAuthEndpoint(
        '/test-login',
        { method: 'POST', body: z.object({ email: z.email(), name: z.string().optional() }) },
        async (ctx) => {
          const email = ctx.body.email.toLowerCase();
          const adapter = ctx.context.internalAdapter;
          const existing = await adapter.findUserByEmail(email, { includeAccounts: false });
          const user =
            existing?.user ??
            (await adapter.createUser(
              { email, name: ctx.body.name ?? email, emailVerified: true },
              { method: 'test-login' },
            ));
          const session = await adapter.createSession(user.id, false);
          await setSessionCookie(ctx, { session, user });
          return ctx.json({ token: session.token, user: { id: user.id, email: user.email } });
        },
      ),
    },
  };
}

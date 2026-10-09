import { APIError, createAuthMiddleware } from 'better-auth/api';
import type { BetterAuthPlugin } from 'better-auth';
import { DEFAULTS } from './defaults';
import { domainIn, parseDomains } from './domains';
import { emitSafely, type SecurityEvent, type SecurityEventSink } from './events';
import type { ReservedDomainCheck } from './reserved';
import { assertNoRedirect, assertSafeUrl, oidcFetchUrls, SsrfError, type SsrfPolicy } from './ssrf';

/**
 * Rule 1 (ADR 0002, decision 2): password sign-up is REFUSED for the staff domain(s) and for every
 * domain an organisation has verified for SSO. Otherwise someone could register `ceo@company.vn`
 * with a password only they know and squat the address before its owner first signs in.
 */
export function companyDomainSignUpGuard(isReserved: ReservedDomainCheck): BetterAuthPlugin {
  return {
    id: 'qnsc-company-domain-sign-up',
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === '/sign-up/email',
          handler: createAuthMiddleware(async (ctx) => {
            const email = (ctx.body as { email?: unknown } | undefined)?.email;
            if (typeof email !== 'string' || !(await isReserved(email))) return;
            throw APIError.from('FORBIDDEN', {
              code: 'USE_COMPANY_SIGN_IN',
              message:
                'This email domain signs in with the company account. Use "Sign in with your company account".',
            });
          }),
        },
      ],
    },
  };
}

/**
 * IdP registration is default-deny (ADR 0002, decision 5, review S6/A12). Better Auth lets ANY
 * signed-in user register an IdP for ANY domain at its default limit. Here:
 *
 * - a provider must belong to an organization (Better Auth then requires the caller to be that
 *   organization's owner or admin) and may not claim a staff domain;
 * - it is unusable until its domain is verified (`domainVerification`, enforced at sign-in);
 * - every URL it makes the server fetch must pass the SSRF check and must not redirect, on BOTH
 *   `/sso/register` and `/sso/update-provider` (an update could point a verified provider at an
 *   internal address);
 * - SAML is out of 8.0.0 (identity plan D18): a `samlConfig` is refused, and so are the SAML routes.
 *
 * What the caller reads in an error is generic; the reason goes to the log.
 */
export function ssoRegistrationGuard(options: {
  staffDomains: readonly string[];
  ssrf: SsrfPolicy;
}): BetterAuthPlugin {
  type Body = {
    organizationId?: unknown;
    domain?: unknown;
    issuer?: unknown;
    oidcConfig?: unknown;
    samlConfig?: unknown;
  };
  const reservedClaim = (domain: unknown): boolean =>
    typeof domain === 'string' &&
    parseDomains(domain).some(
      (d) =>
        domainIn(d, options.staffDomains) ||
        options.staffDomains.some((staff) => domainIn(staff, d)),
    );

  return {
    id: 'qnsc-sso-registration-guard',
    hooks: {
      after: [
        {
          // Better Auth echoes the whole provider, client secret included, in these responses (review S9).
          matcher: (ctx) => ctx.path === '/sso/register' || ctx.path === '/sso/update-provider',
          handler: createAuthMiddleware(async (ctx) => {
            const returned = ctx.context.returned as
              Record<string, unknown> | Response | Error | undefined;
            if (!returned || returned instanceof Error || returned instanceof Response) return;
            const config = returned['oidcConfig'];
            if (!config || typeof config !== 'object') return;
            const { clientSecret: _removed, ...rest } = config as Record<string, unknown>;
            void _removed;
            return ctx.json({ ...returned, oidcConfig: rest });
          }),
        },
      ],
      before: [
        {
          matcher: (ctx) => ctx.path !== undefined && ctx.path.startsWith('/sso/saml'),
          handler: createAuthMiddleware(async () => {
            throw APIError.from('NOT_FOUND', {
              code: 'SAML_NOT_SUPPORTED',
              message: 'SAML is not enabled.',
            });
          }),
        },
        {
          matcher: (ctx) => ctx.path === '/sso/register' || ctx.path === '/sso/update-provider',
          handler: createAuthMiddleware(async (ctx) => {
            const body = (ctx.body ?? {}) as Body;
            if (body.samlConfig !== undefined && body.samlConfig !== null) {
              throw APIError.from('BAD_REQUEST', {
                code: 'SAML_NOT_SUPPORTED',
                message: 'SAML is not enabled.',
              });
            }
            if (
              ctx.path === '/sso/register' &&
              (typeof body.organizationId !== 'string' || !body.organizationId)
            ) {
              throw APIError.from('FORBIDDEN', {
                code: 'SSO_ORGANIZATION_REQUIRED',
                message: 'An SSO provider must belong to an organization you own or administer.',
              });
            }
            if (reservedClaim(body.domain)) {
              throw APIError.from('FORBIDDEN', {
                code: 'SSO_DOMAIN_RESERVED',
                message: 'That domain is reserved.',
              });
            }
            // D16: https and public, and not a redirect, for every URL the server will fetch.
            for (const url of oidcFetchUrls(body.issuer, body.oidcConfig)) {
              try {
                await assertSafeUrl(url, options.ssrf);
                await assertNoRedirect(url);
              } catch (error) {
                if (!(error instanceof SsrfError)) throw error;
                ctx.context.logger.warn(`SSO URL refused: ${error.reason}`, {
                  host: safeHost(url),
                });
                throw APIError.from('BAD_REQUEST', {
                  code: 'SSO_URL_NOT_ALLOWED',
                  message: error.message,
                });
              }
            }
          }),
        },
      ],
    },
  };
}

const safeHost = (raw: string): string => {
  try {
    return new URL(raw).host;
  } catch {
    return 'invalid';
  }
};

const CALLBACK_PATHS = new Set(['/callback/:id', '/sso/callback/:providerId']);

const EVENT_BY_PATH: Record<string, SecurityEvent['name']> = {
  '/request-password-reset': 'password.reset_requested',
  '/reset-password': 'password.reset',
  '/revoke-sessions': 'sessions.revoked',
  '/revoke-other-sessions': 'sessions.revoked',
  '/admin/revoke-user-sessions': 'sessions.revoked',
  '/admin/ban-user': 'admin.user_banned',
};

/**
 * Security events (identity plan §9.4). Only ids and counts leave this plugin: never an address, a
 * password or a token. The client address, when known, is the one the mount resolved.
 */
export function securityEvents(
  sink: SecurityEventSink,
  onSinkError: (e: unknown) => void,
): BetterAuthPlugin {
  const emit = (event: SecurityEvent) => emitSafely(sink, event, onSinkError);
  return {
    id: 'qnsc-security-events',
    hooks: {
      after: [
        {
          // Social (Microsoft, Google) and SSO sign-ins end in a redirect, success or not: the session
          // is the only reliable signal (review A14).
          matcher: (ctx) => ctx.path !== undefined && CALLBACK_PATHS.has(ctx.path),
          handler: createAuthMiddleware(async (ctx) => {
            const userId = ctx.context.newSession?.user.id;
            const ip = ctx.request?.headers.get(DEFAULTS.clientIpHeader) ?? undefined;
            await emit({
              name: userId ? 'sign_in.success' : 'sign_in.failure',
              ...(userId ? { userId } : {}),
              ...(ip ? { ip } : {}),
              detail: { method: ctx.path === '/sso/callback/:providerId' ? 'sso' : 'social' },
            });
          }),
        },
        {
          matcher: (ctx) =>
            ctx.path === '/sign-in/email' || (ctx.path !== undefined && ctx.path in EVENT_BY_PATH),
          handler: createAuthMiddleware(async (ctx) => {
            const failed = ctx.context.returned instanceof Error;
            const ip = ctx.request?.headers.get(DEFAULTS.clientIpHeader) ?? undefined;
            if (ctx.path === '/sign-in/email') {
              const userId = ctx.context.newSession?.user.id;
              await emit({
                name: failed ? 'sign_in.failure' : 'sign_in.success',
                ...(userId ? { userId } : {}),
                ...(ip ? { ip } : {}),
              });
              return;
            }
            if (failed) return; // a refused reset/revoke/ban is not one
            const name = EVENT_BY_PATH[ctx.path ?? ''];
            if (name) await emit({ name, ...(ip ? { ip } : {}) });
          }),
        },
      ],
    },
  };
}

import { betterAuth, type Auth, type BetterAuthOptions, type User } from 'better-auth';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { admin, organization } from 'better-auth/plugins';
import { sso } from '@better-auth/sso';
import type { CacheService } from '@quynhonsemiconductor/platform-cache';
import { decodeJwt } from 'jose';
import { uuidv7 } from 'uuidv7';
import { argon2Password } from './password';
import { accountLockout, DEFAULT_LOCKOUT, type LockoutPolicy } from './lockout';
import type { AuthEmailPort } from './ports';
import { valkeySecondaryStorage, type StorageDegraded } from './storage';
import { withTxCapture } from './tx-context';

/**
 * Header the Fastify mount writes the resolved client address into (after deleting whatever the
 * client sent under that name) and Better Auth reads for rate-limit keys and session IP.
 */
export const CLIENT_IP_HEADER = 'x-qnsc-client-ip';

/**
 * Deliberately the WIDE type. `betterAuth(options)` infers a type that references zod and
 * better-call internals by pnpm path (TS2883) and is too long to serialise (TS7056), so a package
 * built with `declaration: true` cannot export it inferred. The price is that plugin endpoints
 * (`api.createOrganization`, `api.banUser`, …) are not typed through `Identity`.
 */
export type Identity = Auth<BetterAuthOptions>;

export type Preset = 'public' | 'staff' | 'organizations';

export interface IdentityOptions {
  product: string;
  /** The product's Drizzle instance from `platform-db`. */
  db: object;
  /** The product's Drizzle schema (the auth tables). */
  schema: Record<string, unknown>;
  cache: CacheService;
  baseURL: string;
  secret: string;
  /** Static list, or a function evaluated per request (for origins that live in the database). */
  trustedOrigins: string[] | (() => string[] | Promise<string[]>);
  presets: Preset[];
  email: AuthEmailPort;
  /** `staff` preset: the QNSC Entra tenant. `authority` is for tests/sovereign clouds only. */
  microsoft?: { clientId: string; clientSecret: string; tenantId: string; authority?: string };
  hooks?: {
    onUserCreated?: (user: User) => Promise<void> | void;
    onSsoProvisioned?: (user: User, userInfo: Record<string, unknown>) => Promise<void> | void;
  };
  lockout?: LockoutPolicy;
  onStorageDegraded?: StorageDegraded;
  /** Spike knobs, each one a measurement; none would exist in the package. */
  spike?: {
    cookieCache?: boolean;
    storeSessionInDatabase?: boolean;
    databaseTransaction?: boolean;
    backgroundEmail?: boolean;
    session?: { expiresIn?: number; updateAge?: number };
    rateLimit?: { window?: number; max?: number };
    logger?: BetterAuthOptions['logger'];
    sso?: {
      providersLimit?: number;
      disableImplicitSignUp?: boolean;
      domainVerification?: boolean;
      /** Measurement only: turn the `resolveUser` domain binding off to show what Better Auth alone does. */
      bindDomain?: boolean;
      getRole?: (data: {
        user: User;
        userInfo: Record<string, unknown>;
      }) => Promise<'member' | 'admin'>;
    };
  };
}

function requireNonEmpty<T extends string[] | (() => string[] | Promise<string[]>)>(values: T): T {
  if (typeof values === 'function') return values;
  if ((values as string[]).length === 0)
    throw new Error('identity: trustedOrigins must not be empty');
  return values;
}

/**
 * The shape of `createIdentity()` in identity plan §5.3 / Appendix A.1, written against the real
 * Better Auth 1.7.7 API. Everything that is a secure default (§5.4) is set here and not exposed.
 */
export function createIdentity(o: IdentityOptions): Identity {
  const publicPreset = o.presets.includes('public');
  const staffPreset = o.presets.includes('staff');
  const orgPreset = o.presets.includes('organizations');
  const spike = o.spike ?? {};

  const options = {
    appName: o.product,
    baseURL: o.baseURL,
    secret: o.secret,
    trustedOrigins: requireNonEmpty(o.trustedOrigins),
    telemetry: { enabled: false },
    // Failed sign-ins are expected traffic here; the package will route these to observability.
    logger: spike.logger ?? { level: 'error' },
    database: drizzleAdapter(withTxCapture(o.db), {
      provider: 'pg',
      schema: o.schema,
      // Without this Better Auth writes user and credential account in two autocommit statements.
      transaction: spike.databaseTransaction ?? true,
    }),
    secondaryStorage: valkeySecondaryStorage(o.cache, o.onStorageDegraded),
    rateLimit: {
      enabled: true,
      storage: 'secondary-storage',
      ...(spike.rateLimit ?? {}),
    },
    emailAndPassword: publicPreset
      ? {
          enabled: true,
          requireEmailVerification: true,
          minPasswordLength: 12,
          maxPasswordLength: 128,
          revokeSessionsOnPasswordReset: true,
          resetPasswordTokenExpiresIn: 15 * 60,
          password: argon2Password,
          sendResetPassword: ({ user, url, token }: { user: User; url: string; token: string }) =>
            o.email.sendPasswordReset({ user, url, token }),
        }
      : { enabled: false },
    emailVerification: {
      sendOnSignUp: publicPreset,
      // A correct password on an unverified account re-sends the link (the 403 stays).
      sendOnSignIn: publicPreset,
      sendVerificationEmail: ({ user, url, token }: { user: User; url: string; token: string }) =>
        o.email.sendVerification({ user, url, token }),
    },
    socialProviders:
      staffPreset && o.microsoft
        ? {
            microsoft: {
              ...o.microsoft,
              // openid/profile/email only: no Graph permission is requested, no photo fetched.
              disableDefaultScope: true,
              scope: ['openid', 'profile', 'email'],
              disableProfilePhoto: true,
              // Replaces the default `getUserInfo` (which would GET Graph `/me/photos`) with one that
              // also enforces the tenant. In the authorization-code flow Better Auth takes the
              // id_token straight from the tenant-specific token endpoint and never checks `tid`
              // itself, so a token from another tenant would otherwise be accepted. Returning
              // `null` ends the callback with `?error=unable_to_get_user_info` and writes nothing
              // (throwing from `mapProfileToUser` instead surfaces as a 500).
              // Entra issues no `email_verified`; membership of the tenant is the verification.
              getUserInfo: (async (token: { idToken?: string | undefined }) => {
                if (!token.idToken) return null;
                const p = decodeJwt(token.idToken);
                if (p['tid'] !== o.microsoft!.tenantId) return null;
                if (typeof p['oid'] !== 'string' || typeof p['email'] !== 'string') return null;
                return {
                  user: {
                    id: p['oid'],
                    name: typeof p['name'] === 'string' ? p['name'] : p['email'],
                    email: p['email'],
                    emailVerified: true,
                  },
                  data: p,
                };
              }) as never,
            },
          }
        : {},
    session: {
      expiresIn: spike.session?.expiresIn ?? (staffPreset && !publicPreset ? 12 * 3600 : 7 * 86400),
      updateAge: spike.session?.updateAge ?? 86400,
      cookieCache: { enabled: spike.cookieCache ?? false, maxAge: 5 * 60 },
      storeSessionInDatabase: spike.storeSessionInDatabase ?? true,
    },
    // Verification rows (reset tokens, OAuth state) in the DATABASE, identifiers hashed: with
    // `secondaryStorage` set Better Auth would otherwise keep them only in Valkey, and plain.
    verification: { storeInDatabase: true, storeIdentifier: 'hashed' },
    account: {
      encryptOAuthTokens: true,
      accountLinking: { enabled: true, trustedProviders: staffPreset ? ['microsoft'] : [] },
    },
    advanced: {
      useSecureCookies: true,
      // EXPLICIT, never left to the default: Better Auth turns the origin/callback-URL check OFF
      // whenever NODE_ENV === 'test' (see core `isTest()`), so a deployment that ever runs with
      // that value silently loses CSRF and open-redirect protection. `false` pins it on.
      disableOriginCheck: false,
      disableCSRFCheck: false,
      cookiePrefix: o.product,
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
      database: { generateId: () => uuidv7() },
      ...(spike.backgroundEmail
        ? {
            backgroundTasks: {
              handler: (p: Promise<unknown>) => {
                void p;
              },
            },
          }
        : {}),
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user: User) => {
            await o.hooks?.onUserCreated?.(user);
          },
        },
      },
    },
    plugins: [
      ...(orgPreset
        ? [
            organization(),
            sso({
              organizationProvisioning: {
                disabled: false,
                defaultRole: 'member',
                ...(spike.sso?.getRole ? { getRole: spike.sso.getRole } : {}),
              },
              // Provider registration through the API is OFF by default: any signed-in user could
              // otherwise register an IdP that claims any domain. Providers are created by the
              // product (migration / admin tool). The spike turns it on to measure the default.
              providersLimit: spike.sso?.providersLimit ?? 0,
              ...(spike.sso?.disableImplicitSignUp ? { disableImplicitSignUp: true } : {}),
              // Verified domains are what make an SSO email "trusted" (and what lets a provider's
              // users be treated as email-verified). Providers are created by the product, so the
              // `domain_verified` flag is the product's attestation that DNS ownership was checked.
              domainVerification: { enabled: spike.sso?.domainVerification ?? true },
              // Bind every assertion to the provider's own domain(s). Better Auth does not: an IdP
              // may assert ANY address and a user row is created for it. Rejected inside the same
              // transaction as the account write, so nothing is persisted.
              ...(spike.sso?.bindDomain === false
                ? {}
                : {
                    resolveUser: async (
                      input: { providerId: string; providerUser: { email: string } },
                      context: {
                        database: {
                          findOne: (q: {
                            model: string;
                            where: Array<{ field: string; value: string }>;
                          }) => Promise<unknown>;
                        };
                      },
                    ) => {
                      const provider = (await context.database.findOne({
                        model: 'ssoProvider',
                        where: [{ field: 'providerId', value: input.providerId }],
                      })) as { domain?: string } | null;
                      const emailDomain =
                        input.providerUser.email.split('@')[1]?.toLowerCase() ?? '';
                      const allowed = (provider?.domain ?? '')
                        .split(',')
                        .map((d) => d.trim().toLowerCase())
                        .filter(Boolean);
                      const ok = allowed.some(
                        (d) => emailDomain === d || emailDomain.endsWith(`.${d}`),
                      );
                      return ok
                        ? ({ action: 'continue' } as const)
                        : ({
                            action: 'reject',
                            code: 'EMAIL_OUTSIDE_PROVIDER_DOMAIN',
                            message: "Email is outside the provider's domain",
                          } as const);
                    },
                  }),
              provisionUser: async ({
                user,
                userInfo,
              }: {
                user: User;
                userInfo: Record<string, unknown>;
              }) => {
                await o.hooks?.onSsoProvisioned?.(user, userInfo);
              },
              provisionUserOnEveryLogin: false,
            }),
          ]
        : []),
      admin(),
      accountLockout(o.lockout ?? DEFAULT_LOCKOUT),
    ],
  } satisfies BetterAuthOptions;

  return betterAuth(options) as unknown as Identity;
}

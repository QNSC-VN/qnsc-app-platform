import { betterAuth, type Auth, type BetterAuthOptions, type User } from 'better-auth';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { admin, organization, twoFactor } from 'better-auth/plugins';
import type { CacheService } from '@quynhonsemiconductor/platform-cache';
import { uuidv7 } from 'uuidv7';
import { reservedDomainCheck } from './reserved';
import { purgeWith, replaceUnverifiedAccount, type AccountContext } from './accounts';
import { DEFAULTS, type Preset } from './defaults';
import { consoleLogger, noopSink, type IdentityLogger, type SecurityEventSink } from './events';
import { accountLockout } from './lockout';
import { perEmailLimiter } from './mail-limit';
import { AuthMail } from './mail-port';
import { argon2Password } from './password';
import { companyDomainSignUpGuard, securityEvents, ssoRegistrationGuard } from './plugins';
import type { AuthEmailTemplates, JobEnqueue } from './ports';
import {
  googleProvider,
  microsoftProvider,
  type GoogleOptions,
  type StaffOptions,
} from './providers';
import { defaultSsrfPolicy, type SsrfPolicy } from './ssrf';
import { parseKeyring } from './sso-crypto';
import { withEncryptedSsoSecrets } from './sso-protect';
import { ssoPlugin, type SsoHooks } from './sso';
import { valkeySecondaryStorage, type StorageDegraded } from './storage';
import { testLogin } from './test-login';
import { staffSessionHooks } from './staff-session';
import { withCallbackErrorCodes } from './callback-errors';
import { withTimingFloor } from './timing';
import { withTxCapture } from './tx-context';

export const AUTH_BASE_PATH = '/api/auth';

/**
 * Deliberately the WIDE type. `betterAuth(options)` infers a type that references zod and
 * better-call internals by pnpm path (TS2883) and is too long to serialise (TS7056), so a package
 * built with `declaration: true` cannot export it inferred. Plugin endpoints (`api.createOrganization`,
 * `api.banUser`, …) are therefore untyped through `Identity` (WP-9, D1).
 */
export type Identity = Auth<BetterAuthOptions>;

export interface IdentityOptions {
  /** Product name: cookie prefix, 2FA issuer, app name. */
  product: string;
  /** The product's Drizzle instance from `platform-db` (`DATABASE_TOKEN`). */
  db: object;
  /** The product's Drizzle schema: the auth tables, generated with `auth generate`. */
  schema: Record<string, unknown>;
  cache: CacheService;
  baseURL: string;
  /** Static list. Provider origins for SSO are added by the package, after the SSRF check. */
  trustedOrigins: string[];
  presets: Preset[];
  /** Auth emails are enqueued, never awaited (APP-PLATFORM-PLAN.md §4.3 case 1). */
  mail: { jobs: JobEnqueue; templates: AuthEmailTemplates };
  /**
   * May any signed-in user create an organization? Default `false`: organizations are created by
   * the product (an admin tool, onboarding of a partner). Open creation lets a stranger become an
   * organization owner and so register an SSO provider.
   */
  allowOrganizationCreation?: boolean;
  /** Required with the `staff` preset. */
  staff?: StaffOptions;
  /** Optional with the `public` preset. */
  google?: GoogleOptions;
  hooks?: SsoHooks & { onUserCreated?: (user: User) => Promise<void> | void };
  /** Security events (`observability` metrics, the audit table). Default: dropped. */
  events?: SecurityEventSink;
  /** Better Auth's warnings and errors (`observability` logger). Default: Better Auth's own console output. */
  logger?: IdentityLogger;
  onStorageDegraded?: StorageDegraded;
  /** End-to-end suites only: loads the passwordless `/test-login` (identity plan D17). */
  testLogin?: boolean;
  /** Environment; defaults to `process.env`. A test seam, not configuration. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Options that exist for the package's own tests and are NOT part of the public API: they are not on
 * `IdentityOptions`, and `createIdentityInternal` is exported only to `/testing`, never from the root.
 */
export interface InternalOptions {
  /**
   * Lets an SSO provider live on localhost over http (the mock IdP). Refused when NODE_ENV is
   * `production`; the conformance kit asserts the default policy.
   */
  unsafeTestNetwork?: boolean;
}

const MIN_SECRET_LENGTH = 32;

function config(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`identity: ${message}`);
}

// What a product handed us, for helpers that take the built instance (purgeUnverifiedAccounts).
const internals = new WeakMap<
  object,
  {
    getContext: () => Promise<AccountContext>;
    sink: SecurityEventSink;
  }
>();

/**
 * Build the configured Better Auth instance. Every secure default of identity plan §5.4 is set here
 * and is not exposed as an option; what a product chooses is typed policy (presets, providers,
 * guests, origins, templates).
 */
export function createIdentity(o: IdentityOptions): Identity {
  return createIdentityInternal(o, {});
}

export function createIdentityInternal(o: IdentityOptions, internal: InternalOptions): Identity {
  const env = o.env ?? process.env;
  const production = env['NODE_ENV'] === 'production';
  const has = (p: Preset) => o.presets.includes(p);
  const publicPreset = has('public');
  const staffPreset = has('staff');
  const orgPreset = has('organizations');

  config(o.presets.length > 0, 'at least one preset is required');
  config(o.trustedOrigins.length > 0, 'trustedOrigins must not be empty');
  config(!staffPreset || o.staff, 'the staff preset needs `staff` (tenant, client, domains)');
  const secret = env[DEFAULTS.secretEnv];
  config(
    secret && secret.length >= MIN_SECRET_LENGTH,
    `${DEFAULTS.secretEnv} must be set (32+ characters)`,
  );
  config(!production || o.baseURL.startsWith('https://'), 'baseURL must be https in production');
  config(!(production && internal.unsafeTestNetwork), 'unsafeTestNetwork is refused in production');
  const ring = orgPreset ? parseKeyring(env[DEFAULTS.encryptionKeyEnv]) : undefined;

  const sink = o.events ?? noopSink;
  const onSinkError = (e: unknown) => o.onStorageDegraded?.('events', e);
  const ssrf: SsrfPolicy = {
    ...defaultSsrfPolicy,
    allowLocalNetwork: internal.unsafeTestNetwork === true,
  };
  const staffDomains = o.staff?.domains ?? [];
  const storage = valkeySecondaryStorage(o.cache, o.onStorageDegraded);
  const mail = new AuthMail(
    o.mail.jobs,
    o.mail.templates,
    perEmailLimiter(storage),
    o.logger ?? consoleLogger,
  );

  // Assigned once below; the closures that read it are built first and only run later.
  // eslint-disable-next-line prefer-const
  let auth!: Identity;
  const getContext = () => auth.$context as unknown as Promise<AccountContext>;
  const lookup = async (email: string) =>
    (await getContext()).internalAdapter.findUserByEmail(email.toLowerCase(), {
      includeAccounts: true,
    }) as Promise<{
      accounts: Array<{ providerId: string; accountId: string }>;
    } | null>;
  const isReserved = reservedDomainCheck({ staffDomains, withSso: orgPreset, getContext });
  const onVerifiedEmail = (email: string) => replaceUnverifiedAccount(getContext, sink, email);

  const sessionPolicy =
    staffPreset && !publicPreset ? DEFAULTS.session.staff : DEFAULTS.session.public;
  // A staff preset anywhere turns the cookie cache off: a revoked staff session must die on the
  // next request, and the cache is per instance.
  const cookieCache = sessionPolicy.cookieCache && !staffPreset;

  const database = drizzleAdapter(withTxCapture(o.db), {
    provider: 'pg',
    schema: o.schema,
    // Without this user and credential account are two autocommit statements, and the sign-up
    // verification mail cannot join the transaction (WP-9, D4).
    transaction: true,
  });

  const options = {
    appName: o.product,
    baseURL: o.baseURL,
    secret,
    // STATIC, on purpose. Origins derived from SSO provider rows would be attacker-controlled (an
    // organization registers a provider whose origin is its own) and would make every redirectTo /
    // callbackURL check, including the password-reset link, accept that origin. Better Auth's own
    // fetch-time check (public hosts only) covers discovery.
    trustedOrigins: [...o.trustedOrigins],
    telemetry: { enabled: false },
    // Impersonation is OFF in 8.0.0 (review S8). It returns in 8.1 with a required reason, a 1 h limit
    // and an audit record; until then the endpoints do not exist.
    disabledPaths: ['/admin/impersonate-user', '/admin/stop-impersonating'],
    logger: o.logger
      ? {
          level: 'warn',
          log: (level: string, message: string) => {
            if (level === 'error') o.logger!.error(message);
            else if (level === 'warn') o.logger!.warn(message);
          },
        }
      : { level: 'error' },
    database: ring ? withEncryptedSsoSecrets(database, ring) : database,
    secondaryStorage: storage,
    rateLimit: { enabled: true, storage: 'secondary-storage' },
    emailAndPassword: publicPreset
      ? {
          enabled: true,
          requireEmailVerification: true,
          minPasswordLength: DEFAULTS.password.minLength,
          maxPasswordLength: DEFAULTS.password.maxLength,
          revokeSessionsOnPasswordReset: DEFAULTS.reset.revokeSessions,
          resetPasswordTokenExpiresIn: DEFAULTS.reset.tokenTtlSeconds,
          password: argon2Password,
          sendResetPassword: (data: { user: User; url: string; token: string }) =>
            mail.sendPasswordReset(data),
        }
      : { enabled: false },
    emailVerification: {
      sendOnSignUp: publicPreset,
      sendOnSignIn: publicPreset,
      sendVerificationEmail: (data: { user: User; url: string; token: string }) =>
        mail.sendVerification(data),
    },
    socialProviders: {
      ...(staffPreset
        ? { microsoft: microsoftProvider(o.staff!, { onVerifiedEmail, lookup }) }
        : {}),
      ...(publicPreset && o.google
        ? { google: googleProvider(o.google, { onVerifiedEmail, isReserved }) }
        : {}),
    },
    session: {
      expiresIn: sessionPolicy.expiresInSeconds,
      updateAge: sessionPolicy.updateAgeSeconds,
      cookieCache: { enabled: cookieCache, maxAge: DEFAULTS.session.cookieCacheSeconds },
      // Sessions live in Postgres too: a Valkey restart must not sign everyone out, and the `sso`
      // resolver requires database-backed sessions.
      storeSessionInDatabase: true,
    },
    // Verification rows (reset tokens, OAuth state) in the DATABASE, identifiers hashed.
    verification: { storeInDatabase: true, storeIdentifier: 'hashed' },
    account: {
      encryptOAuthTokens: true,
      // Automatic linking only for providers whose address is proven: the tenant, or a verified
      // domain (and then only for members of the provider's organization, see `ssoPlugin`).
      // No provider is trusted by NAME: Microsoft members come with `emailVerified: true`, which
      // links them, and guests come with `false`, which makes Better Auth refuse (review S3).
      accountLinking: { enabled: true, trustedProviders: [] },
    },
    advanced: {
      useSecureCookies: true,
      cookiePrefix: o.product,
      // EXPLICIT, never left to the default: Better Auth turns the origin/callback-URL check off
      // whenever NODE_ENV === 'test' (WP-9, D6).
      disableOriginCheck: false,
      disableCSRFCheck: false,
      ipAddress: { ipAddressHeaders: [DEFAULTS.clientIpHeader] },
      database: { generateId: () => uuidv7() },
    },
    databaseHooks: {
      ...(staffPreset ? { session: staffSessionHooks({ staffDomains, getContext }) as never } : {}),
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
            organization({ allowUserToCreateOrganization: o.allowOrganizationCreation === true }),
            ssoPlugin({ hooks: o.hooks, getContext, sink }),
            ssoRegistrationGuard({ staffDomains, ssrf }),
          ]
        : []),
      admin({ allowImpersonatingAdmins: false }),
      ...(publicPreset ? [twoFactor({ issuer: o.product })] : []),
      accountLockout(sink),
      companyDomainSignUpGuard(isReserved),
      securityEvents(sink, onSinkError),
      ...(o.testLogin ? [testLogin(env)] : []),
    ],
  } satisfies BetterAuthOptions;

  auth = betterAuth(options) as unknown as Identity;
  auth.handler = withCallbackErrorCodes(withTimingFloor(auth.handler, AUTH_BASE_PATH));
  internals.set(auth, { getContext, sink });
  return auth;
}

/**
 * Delete unverified accounts older than 72 hours that never held a session and have no social or SSO
 * account (identity plan D20). Each product schedules this with `platform-jobs`; until WP-7 lands,
 * with `ExclusiveJob`. Safe to run concurrently. Returns how many accounts were deleted.
 */
export function purgeUnverifiedAccounts(
  auth: Identity,
  options: { now?: Date } = {},
): Promise<number> {
  const internal = internals.get(auth);
  if (!internal)
    throw new Error('identity: purgeUnverifiedAccounts needs an instance from createIdentity()');
  return purgeWith(internal.getContext, internal.sink, options);
}

export function identityInternals(auth: Identity) {
  return internals.get(auth);
}

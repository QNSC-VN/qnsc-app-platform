import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import Redis from 'ioredis';
import type { Pool } from 'pg';
import { CacheService } from '@quynhonsemiconductor/platform-cache';
import { createDatabase, type DbExecutor } from '@quynhonsemiconductor/platform-db/drizzle';
import {
  createIdentityInternal,
  AUTH_BASE_PATH,
  type Identity,
  type IdentityOptions,
} from '../create-identity';
import { DEFAULTS } from '../defaults';
import type { SecurityEvent } from '../events';
import { MAIL_QUEUE, type EmailMessage } from '../ports';
import { TestClient } from './client';
import { TEST_JOBS_DDL, TestJobs } from './jobs';
import { REFERENCE_DDL } from './reference-ddl';
import * as referenceSchema from './reference-schema';

/**
 * What the kit needs from the environment it runs in. The package does not start containers: a
 * product supplies a PostgreSQL 18 database and a Valkey (its CI already has both), `app-platform`
 * supplies them from `@quynhonsemiconductor/testing`.
 */
export interface ConformanceInfra {
  /** A fresh, EMPTY database. `stop` runs when the stack is torn down. */
  database(): Promise<{ pool: Pool; stop?: () => Promise<void> }>;
  /** A Valkey URL and a key prefix no other stack uses. */
  valkey(): Promise<{ url: string; keyPrefix: string }>;
}

export const APP_ORIGIN = 'https://app.identity.test';

export interface StackOptions {
  presets?: IdentityOptions['presets'];
  staff?: Partial<NonNullable<IdentityOptions['staff']>>;
  google?: IdentityOptions['google'];
  hooks?: IdentityOptions['hooks'];
  testLogin?: boolean;
  unsafeTestNetwork?: boolean;
  /** Merged over the environment `createIdentity` sees (secret, encryption key, NODE_ENV…). */
  env?: NodeJS.ProcessEnv;
  extraTrustedOrigins?: string[];
  onStorageDegraded?: IdentityOptions['onStorageDegraded'];
  allowOrganizationCreation?: boolean;
  /** Point the app at a cache that is not there (an outage). The kit's own checks still use the real Valkey. */
  appValkeyUrl?: string;
  /** Queues the job stand-in accepts (as `platform-jobs` accepts only defined ones). Default: all. */
  registeredQueues?: string[];
}

export interface Stack {
  auth: Identity;
  pool: Pool;
  db: DbExecutor;
  cache: CacheService;
  jobs: TestJobs;
  events: SecurityEvent[];
  /** What was routed to the `logger` option (Better Auth's warnings and errors). */
  logs: Array<{
    level: 'warn' | 'error';
    message: string;
    fields?: Record<string, string | number | boolean> | undefined;
  }>;
  env: NodeJS.ProcessEnv;
  origin: string;
  client(defaults?: { ip?: string; origin?: string }): TestClient;
  /** Auth emails enqueued so far, oldest first. */
  mail(): Promise<EmailMessage[]>;
  /** Keys in Valkey matching `pattern`, as stored (the product prefix included in the result). */
  keys(pattern: string): Promise<string[]>;
  ttl(fullKey: string): Promise<number>;
  /** Set a counter the package keeps in Valkey (full key without the product prefix), to reach a limit without minutes of requests. */
  seedCounter(key: string, value: number, ttlSeconds?: number): Promise<unknown>;
  /** Read a key the package keeps in Valkey (without the product prefix). */
  get(key: string): Promise<string | null>;
  /** Drop everything this stack cached in Valkey (sessions included): reads fall back to Postgres. */
  flushCache(): Promise<void>;
  /** The link in the single mail sent to `to`. */
  link(to: string): Promise<string>;
  stop(): Promise<void>;
}

export const TEST_TENANT = '11111111-1111-4111-8111-111111111111';
export const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
export const STAFF_DOMAIN = 'staff.identity.test';

/** Boot `createIdentity` over real PostgreSQL and Valkey, with the reference schema migrated. */
export async function startStack(
  infra: ConformanceInfra,
  options: StackOptions = {},
): Promise<Stack> {
  const database = await infra.database();
  for (const statement of REFERENCE_DDL.split('--> statement-breakpoint')) {
    if (statement.trim()) await database.pool.query(statement);
  }
  await database.pool.query(TEST_JOBS_DDL);
  const db = createDatabase(database.pool, { schema: referenceSchema });

  const valkey = await infra.valkey();
  const cache = new CacheService({
    url: options.appValkeyUrl ?? valkey.url,
    keyPrefix: valkey.keyPrefix,
    mode: 'required',
  });
  cache.onModuleInit();
  // Requests made before the connection is ready skip the limiters (fail open), which would make a
  // test's first requests uncounted. Wait for it, unless the test wants an outage.
  if (!options.appValkeyUrl) {
    for (let i = 0; i < 100 && !cache.isAvailable; i += 1)
      await new Promise((r) => setTimeout(r, 50));
  }

  const raw = new Redis(valkey.url);
  const jobs = new TestJobs(
    db,
    options.registeredQueues ? new Set(options.registeredQueues) : undefined,
  );
  const events: SecurityEvent[] = [];
  const logs: Stack['logs'] = [];
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'development',
    [DEFAULTS.secretEnv]: randomBytes(32).toString('hex'), // generated per stack, never committed
    [DEFAULTS.encryptionKeyEnv]: randomBytes(32).toString('base64'),
    ...options.env,
  };
  const presets = options.presets ?? ['public'];

  // Whatever fails from here on must not leak a pool, a Redis connection or a cache client: a kit
  // test that EXPECTS createIdentity to throw would otherwise leave them open for the whole run.
  let auth: Identity;
  try {
    auth = createIdentityInternal(
      {
        product: 'conformance',
        db,
        schema: referenceSchema,
        cache,
        baseURL: APP_ORIGIN,
        trustedOrigins: [APP_ORIGIN, ...(options.extraTrustedOrigins ?? [])],
        presets,
        mail: {
          jobs,
          templates: {
            verifyEmail: ({ url }) => ({ subject: 'Verify', html: url, text: url }),
            resetPassword: ({ url }) => ({ subject: 'Reset', html: url, text: url }),
          },
        },
        ...(presets.includes('staff')
          ? {
              staff: {
                tenantId: TEST_TENANT,
                clientId: 'conformance-client',
                clientSecret: `conformance-${randomBytes(8).toString('hex')}`,
                domains: [STAFF_DOMAIN],
                ...options.staff,
              },
            }
          : {}),
        ...(options.google ? { google: options.google } : {}),
        ...(options.hooks ? { hooks: options.hooks } : {}),
        ...(options.testLogin ? { testLogin: true } : {}),
        ...(options.allowOrganizationCreation ? { allowOrganizationCreation: true } : {}),
        ...(options.onStorageDegraded ? { onStorageDegraded: options.onStorageDegraded } : {}),
        events: { emit: (e) => void events.push(e) },
        logger: {
          warn: (message, fields) => void logs.push({ level: 'warn', message, fields }),
          error: (message, fields) => void logs.push({ level: 'error', message, fields }),
        },
        env,
      },
      { unsafeTestNetwork: options.unsafeTestNetwork ?? true },
    );
  } catch (error) {
    raw.disconnect();
    await cache.onApplicationShutdown().catch(() => undefined);
    await database.stop?.().catch(() => undefined);
    throw error;
  }

  const keys = async (pattern: string): Promise<string[]> => {
    const out: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await raw.scan(
        cursor,
        'MATCH',
        `${valkey.keyPrefix}${pattern}`,
        'COUNT',
        500,
      );
      out.push(...batch);
      cursor = next;
    } while (cursor !== '0');
    return out;
  };

  const mail = async (): Promise<EmailMessage[]> => {
    const { rows } = await database.pool.query<{ data: EmailMessage }>(
      `select data from identity_test_jobs where queue = $1 order by created_at, id`,
      [MAIL_QUEUE],
    );
    return rows.map((r) => r.data);
  };

  return {
    auth,
    pool: database.pool,
    db,
    cache,
    jobs,
    events,
    logs,
    env,
    origin: APP_ORIGIN,
    client: (defaults) => new TestClient(APP_ORIGIN, auth.handler, defaults),
    mail,
    keys,
    ttl: (fullKey) => raw.ttl(fullKey),
    get: (key) => raw.get(`${valkey.keyPrefix}${key}`),
    seedCounter: (key, value, ttlSeconds = 900) =>
      raw.set(`${valkey.keyPrefix}${key}`, String(value), 'EX', ttlSeconds),
    async flushCache() {
      const all = await keys('*');
      if (all.length > 0) await raw.del(...all);
    },
    async link(to) {
      const mine = (await mail()).filter((m) => m.to === to);
      if (mine.length !== 1) throw new Error(`expected one mail to ${to}, found ${mine.length}`);
      return mine[0]!.text;
    },
    async stop() {
      raw.disconnect();
      await cache.onApplicationShutdown();
      await database.stop?.();
    },
  };
}

export const API = AUTH_BASE_PATH;
export const strongPassword = (): string => `pw-${crypto.randomUUID()}`;
export const uniqueEmail = (tag: string): string =>
  `${tag}-${crypto.randomUUID().slice(0, 8)}@users.identity.test`;
export { sql };

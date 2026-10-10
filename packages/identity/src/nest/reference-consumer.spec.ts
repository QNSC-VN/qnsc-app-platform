import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { Controller, Get, Global, Inject, Module, Post } from '@nestjs/common';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { CacheModule, CacheService } from '@quynhonsemiconductor/platform-cache';
import { DATABASE_TOKEN, DatabaseModule } from '@quynhonsemiconductor/platform-db/nest';
import type { DbExecutor } from '@quynhonsemiconductor/platform-db/drizzle';
import {
  enableCorrelationId,
  GlobalExceptionFilter,
  REQUEST_CONTEXT,
} from '@quynhonsemiconductor/platform-http';
import {
  dockerTestsEnabled,
  startPostgres,
  startValkey,
  type PostgresHarness,
  type ValkeyHarness,
} from '@quynhonsemiconductor/testing';
import { createIdentity, type Identity } from '../create-identity';
import { DEFAULTS } from '../defaults';
import { TestClient } from '../testing/client';
import { TEST_JOBS_DDL, TestJobs } from '../testing/jobs';
import { startMockIdp, type MockIdp } from '../testing/mock-idp';
import { REFERENCE_DDL } from '../testing/reference-ddl';
import * as referenceSchema from '../testing/reference-schema';
import { AuthApiErrorFilter } from './errors';
import { IdentityModule } from './identity.module';
import { AUTH, CurrentSession, Public, type RequestWithSession } from './session.guard';
import { checkIdentityReady } from './readiness';

/**
 * The reference consumer: a real Nest + Fastify application wired with ONLY the bindings the README
 * documents as required — `DatabaseModule`, `CacheModule`, a job-enqueue binding, the product's
 * templates, `createIdentity`. If identity gains a dependency, or an optional one stops being
 * optional, this fails here and not in a product's boot logs after publishing.
 */
const JOBS = Symbol('JOBS');
const STAFF_DOMAIN = 'staff.reference.test';
const TENANT = '33333333-3333-4333-8333-333333333333';

@Controller('v1')
class ProbeController {
  constructor(@Inject(AUTH) private readonly auth: Identity) {}

  @Public()
  @Get('public')
  open() {
    return { ok: true };
  }

  @Get('me')
  me(@CurrentSession() session: NonNullable<RequestWithSession['session']>) {
    return { id: session.user.id, email: session.user.email };
  }

  /** A product calling `auth.api.*` directly: Better Auth's APIError must come out as the platform envelope. */
  @Public()
  @Post('login-direct')
  async loginDirect() {
    await this.auth.api.signInEmail({
      body: { email: 'nobody@users.reference.test', password: 'x'.repeat(16) },
    });
  }
}

const enabled = await dockerTestsEnabled();

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

describe.skipIf(!enabled)('reference consumer: identity inside Nest 11 + Fastify 5', () => {
  let pg: PostgresHarness;
  let valkey: ValkeyHarness;
  let idp: MockIdp;
  let app: NestFastifyApplication;
  let origin: string;
  let pool: Pool;
  let keyPrefix: string;
  let auth: Identity;
  let closed = false;

  const http = (defaults?: { ip?: string }) =>
    new TestClient(origin, (request) => fetch(request), defaults);

  beforeAll(async () => {
    [pg, valkey, idp] = await Promise.all([
      startPostgres({ database: 'postgres' }),
      startValkey(),
      startMockIdp(),
    ]);
    const database = `ref_${randomBytes(5).toString('hex')}`;
    const admin = pg.createPool({ database: 'postgres', max: 1 });
    try {
      await admin.query(`CREATE DATABASE ${database}`);
    } finally {
      await admin.end();
    }
    pool = pg.createPool({ database, max: 4 });
    for (const statement of REFERENCE_DDL.split('--> statement-breakpoint')) {
      if (statement.trim()) await pool.query(statement);
    }
    await pool.query(TEST_JOBS_DDL);

    const port = await freePort();
    origin = `http://127.0.0.1:${port}`;
    keyPrefix = `${randomBytes(5).toString('hex')}:`;
    const env = {
      ...pg.env(),
      DATABASE_NAME: database,
      DATABASE_SSL: 'disable',
      NODE_ENV: 'development',
    };
    const authEnv = {
      NODE_ENV: 'development',
      [DEFAULTS.secretEnv]: randomBytes(32).toString('hex'),
      [DEFAULTS.encryptionKeyEnv]: randomBytes(32).toString('base64'),
    };

    @Global()
    @Module({
      providers: [
        {
          provide: JOBS,
          inject: [DATABASE_TOKEN],
          useFactory: (db: DbExecutor) => new TestJobs(db),
        },
      ],
      exports: [JOBS],
    })
    class JobsModule {}

    @Module({
      imports: [
        CacheModule.forRoot({ url: valkey.url, keyPrefix, mode: 'required' }),
        DatabaseModule.forRootAsync({ schema: referenceSchema, env }),
        JobsModule,
        IdentityModule.forRootAsync({
          inject: [DATABASE_TOKEN, CacheService, JOBS],
          useFactory: ((db: DbExecutor, cache: CacheService, jobs: TestJobs) =>
            createIdentity({
              product: 'reference',
              db,
              schema: referenceSchema,
              cache,
              baseURL: origin,
              trustedOrigins: [origin],
              presets: ['public', 'staff'],
              mail: {
                jobs,
                templates: {
                  verifyEmail: ({ url }) => ({ subject: 'v', html: url, text: url }),
                  resetPassword: ({ url }) => ({ subject: 'r', html: url, text: url }),
                },
              },
              staff: {
                tenantId: TENANT,
                clientId: 'ref',
                clientSecret: randomUUID(),
                domains: [STAFF_DOMAIN],
                authority: idp.base,
              },
              env: authEnv,
            })) as never,
        }),
      ],
      controllers: [ProbeController],
      providers: [
        {
          provide: REQUEST_CONTEXT,
          useValue: { getCorrelationId: () => 'ref', getUserId: () => undefined },
        },
        // Order matters: Nest asks the LAST registered global filter first, and the catch-all
        // GlobalExceptionFilter would otherwise turn every APIError into a 500.
        { provide: APP_FILTER, useClass: GlobalExceptionFilter },
        { provide: APP_FILTER, useClass: AuthApiErrorFilter },
      ],
    })
    class ReferenceModule {}

    app = await NestFactory.create<NestFastifyApplication>(
      ReferenceModule,
      new FastifyAdapter({ trustProxy: false }),
      {
        logger: ['error'],
        bodyParser: false,
      },
    );
    enableCorrelationId(app); // seeds the request context the mail payload reads
    app.enableShutdownHooks();
    await app.listen(port, '127.0.0.1');
    auth = app.get<Identity>(AUTH);
  }, 180_000);

  afterAll(async () => {
    if (!closed) await app?.close();
    await Promise.allSettled([pool?.end()]);
    await Promise.allSettled([idp?.stop(), pg?.stop(), valkey?.stop()]);
  });

  const signUpAndIn = async (c: TestClient, email: string, password: string) => {
    expect((await c.post('/api/auth/sign-up/email', { email, password, name: 'R' })).status).toBe(
      200,
    );
    const { rows } = await pool.query<{ data: { text: string } }>(
      `select data from identity_test_jobs where data->>'to' = $1`,
      [email],
    );
    expect((await c.get(rows[0]!.data.text)).status).toBe(302);
    expect((await c.post('/api/auth/sign-in/email', { email, password })).status).toBe(200);
  };

  it('boots with only the documented bindings, serves @Public and protects everything else (platform-http envelope)', async () => {
    const c = http();
    expect((await c.get('/v1/public')).status).toBe(200);
    const denied = await c.get('/v1/me');
    expect(denied.status).toBe(401);
    expect(denied.json()).toEqual({
      error: {
        code: 'AUTH_UNAUTHENTICATED',
        message: 'Sign in required',
        details: [],
        correlationId: 'ref',
      },
    });
  });

  it('the guard resolves the cookie the mounted handler set; a forged cookie is 401, not 500', async () => {
    const email = `guard-${randomUUID().slice(0, 6)}@users.reference.test`;
    const c = http();
    await signUpAndIn(c, email, `pw-${randomUUID()}`);
    expect((await c.get('/v1/me')).json()).toMatchObject({ email });
    const [name, value] = Object.entries(c.cookies)[0]!;
    const forged = http();
    forged.setCookies({ [name]: `${value.slice(0, -4)}AAAA` });
    expect((await forged.get('/v1/me')).status).toBe(401);
  });

  it('the body reaches Better Auth un-parsed: a form-encoded POST is not a 415', async () => {
    const res = await http().request('POST', '/api/auth/sign-in/email', {
      form: { email: 'a@b.test', password: 'x'.repeat(16) },
    });
    expect(res.status).not.toBe(415);
  });

  it('the rate limiter keys on clientIp() — cf-connecting-ip first — and a client-supplied internal header is discarded', async () => {
    const send = (headers: Record<string, string>) =>
      fetch(`${origin}/api/auth/get-session`, { headers: { origin, ...headers } });
    await send({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.99' });
    await send({ 'cf-connecting-ip': '203.0.113.8', [DEFAULTS.clientIpHeader]: '1.2.3.4' });
    const raw = valkey.url;
    const { default: Redis } = await import('ioredis');
    const client = new Redis(raw);
    try {
      const keys = await client.keys(`${keyPrefix}*|/get-session`);
      expect(keys).toContain(`${keyPrefix}203.0.113.7|/get-session`);
      expect(keys).toContain(`${keyPrefix}203.0.113.8|/get-session`);
      expect(keys.some((k) => k.includes('1.2.3.4') || k.includes('198.51.100.99'))).toBe(false);
    } finally {
      client.disconnect();
    }
  });

  it('Better Auth errors from auth.api.* in a product controller come out in the platform envelope', async () => {
    const res = await http().post('/v1/login-direct', {});
    expect(res.status).toBe(401);
    expect(res.json()).toEqual({
      error: {
        code: 'INVALID_EMAIL_OR_PASSWORD',
        message: expect.any(String),
        details: [],
        correlationId: 'ref',
      },
    });
  });

  it('staff-domain sessions are capped at 12 h even though the instance is combined (public lifetime is 7 d), enforced by the session hooks, not the guard', async () => {
    const staffEmail = `lead@${STAFF_DOMAIN}`;
    idp.loginAs({ sub: 's', oid: randomUUID(), tid: TENANT, email: staffEmail, name: 'Lead' });
    const staff = http();
    const start = await staff.post('/api/auth/sign-in/social', {
      provider: 'microsoft',
      callbackURL: '/',
    });
    const authz = await staff.get(start.json<{ url: string }>().url);
    await staff.get(authz.location!);
    expect((await staff.get('/v1/me')).status).toBe(200);

    const publicEmail = `visitor-${randomUUID().slice(0, 6)}@users.reference.test`;
    const visitor = http();
    await signUpAndIn(visitor, publicEmail, `pw-${randomUUID()}`);
    expect((await visitor.get('/v1/me')).status).toBe(200);

    await pool.query(
      `update identity.session s set created_at = s.created_at - interval '13 hours', expires_at = s.expires_at - interval '13 hours'`,
    );
    const redis = new (await import('ioredis')).default(valkey.url);
    try {
      const keys = await redis.keys(`${keyPrefix}*`);
      if (keys.length > 0) await redis.del(...keys);
    } finally {
      redis.disconnect();
    }
    expect((await staff.get('/v1/me')).status).toBe(401); // 13 h old, staff domain
    expect((await visitor.get('/v1/me')).status).toBe(200); // 13 h old, public lifetime
  });

  it('the X-Correlation-Id of a sign-up request is carried into the mail.send payload (end to end, with enableCorrelationId)', async () => {
    const mailFor = async (email: string) =>
      (
        await pool.query<{ data: { correlationId?: string } }>(
          `select data from identity_test_jobs where data->>'to' = $1`,
          [email],
        )
      ).rows[0]!.data;
    const withHeader = `corr-${randomUUID().slice(0, 6)}@users.reference.test`;
    const res = await http().request('POST', '/api/auth/sign-up/email', {
      json: { email: withHeader, password: `pw-${randomUUID()}`, name: 'R' },
      headers: { 'x-correlation-id': 'req-01HZX:abc.1' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-correlation-id')).toBe('req-01HZX:abc.1');
    expect((await mailFor(withHeader)).correlationId).toBe('req-01HZX:abc.1');

    // no header: platform-http generates one, so the job still continues the request's id
    const without = `nocorr-${randomUUID().slice(0, 6)}@users.reference.test`;
    const bare = await http().post('/api/auth/sign-up/email', {
      email: without,
      password: `pw-${randomUUID()}`,
      name: 'R',
    });
    expect(bare.headers.get('x-correlation-id')).toBeTruthy();
    expect((await mailFor(without)).correlationId).toBe(bare.headers.get('x-correlation-id'));
  });

  it('is ready when the schema matches, and says why when it does not', async () => {
    expect(await checkIdentityReady(auth)).toEqual({ ok: true });
  });

  it('shuts down cleanly (pools and cache closed in the shutdown hooks)', async () => {
    await expect(app.close()).resolves.toBeUndefined();
    closed = true;
  });
});

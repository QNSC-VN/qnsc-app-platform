import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  dockerTestsEnabled,
  startPostgres,
  type PostgresHarness,
} from '@quynhonsemiconductor/testing';
import { sql } from 'drizzle-orm';
import { pgTable, integer } from 'drizzle-orm/pg-core';
import type { Pool } from 'pg';
import { pingDatabase } from '../ping';
import { DatabaseConfigError } from '../errors';
import type { Database, DbExecutor } from '../drizzle';
import {
  DATABASE_POOL_TOKEN,
  DATABASE_READ_POOL_TOKEN,
  DatabaseModule,
  InjectDatabase,
  InjectDatabasePool,
} from './index';

const schema = { t: pgTable('t', { id: integer('id').primaryKey() }) };
type Schema = typeof schema;

@Injectable()
class Consumer {
  constructor(
    @InjectDatabase() readonly db: Database<Schema> & DbExecutor<Schema>,
    @InjectDatabasePool() readonly pool: Pool,
  ) {}
}

const enabled = await dockerTestsEnabled();

describe.skipIf(!enabled)('DatabaseModule', () => {
  let pg: PostgresHarness;
  beforeAll(async () => {
    pg = await startPostgres({ tls: true });
  }, 180_000);
  afterAll(async () => {
    await pg?.stop();
  }, 60_000);

  function appModule(env: Record<string, string>) {
    @Module({
      imports: [DatabaseModule.forRootAsync({ schema, env })],
      providers: [Consumer],
    })
    class AppModule {}
    return AppModule;
  }

  it('provides the Drizzle instance and the pool, and the database answers over verified TLS', async () => {
    const app = await NestFactory.createApplicationContext(appModule(pg.env()), { logger: false });
    try {
      const { db, pool } = app.get(Consumer);
      const { rows } = await db.execute<{ ssl: boolean }>(
        sql`SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()`,
      );
      expect(rows[0]).toEqual({ ssl: true });
      await pingDatabase(pool);
      expect(app.get(DATABASE_READ_POOL_TOKEN)).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('exposes the pool under a registry symbol, so platform-runtime can find it without importing this package', async () => {
    expect(DATABASE_POOL_TOKEN).toBe(Symbol.for('@quynhonsemiconductor/platform-db:pool'));
    const app = await NestFactory.createApplicationContext(appModule(pg.env()), { logger: false });
    try {
      expect(app.get(DATABASE_POOL_TOKEN)).toBe(app.get(Consumer).pool);
    } finally {
      await app.close();
    }
  });

  it('ends the pool when the app closes (the shutdown hook)', async () => {
    const app = await NestFactory.createApplicationContext(appModule(pg.env()), { logger: false });
    const { pool } = app.get(Consumer);
    await pingDatabase(pool);
    await app.close();
    await expect(pool.query('SELECT 1')).rejects.toThrow(/pool/i);
  });

  it('creates the read pool when DATABASE_READ_HOST is set, and ends it too', async () => {
    const app = await NestFactory.createApplicationContext(
      appModule({ ...pg.env(), DATABASE_READ_HOST: pg.host }),
      { logger: false },
    );
    const read = app.get<Pool | null>(DATABASE_READ_POOL_TOKEN);
    expect(read).not.toBeNull();
    await pingDatabase(read!);
    await app.close();
    await expect(read!.query('SELECT 1')).rejects.toThrow(/pool/i);
  });

  it('does NOT crash the boot when the database is briefly unreachable: /readyz gates traffic', async () => {
    const app = await NestFactory.createApplicationContext(
      appModule({ ...pg.env(), DATABASE_PASSWORD: 'wrong-on-purpose' }),
      { logger: false },
    );
    await app.close();
  });
});

describe('DatabaseModule configuration errors fail the boot, naming the variable', () => {
  it('missing DATABASE_PASSWORD', async () => {
    @Module({
      imports: [
        DatabaseModule.forRootAsync({
          schema,
          env: {
            DATABASE_HOST: 'h',
            DATABASE_NAME: 'n',
            DATABASE_USER: 'u',
            DATABASE_SSL: 'disable',
          },
        }),
      ],
    })
    class Broken {}
    await expect(
      NestFactory.createApplicationContext(Broken, { logger: false, abortOnError: false }),
    ).rejects.toThrow(DatabaseConfigError);
  });

  it('DATABASE_SSL=disable in production', async () => {
    @Module({
      imports: [
        DatabaseModule.forRootAsync({
          schema,
          env: {
            DATABASE_HOST: 'h',
            DATABASE_NAME: 'n',
            DATABASE_USER: 'u',
            DATABASE_PASSWORD: 'p',
            DATABASE_SSL: 'disable',
            NODE_ENV: 'production',
          },
        }),
      ],
    })
    class Broken {}
    await expect(
      NestFactory.createApplicationContext(Broken, { logger: false, abortOnError: false }),
    ).rejects.toThrow(/refused when NODE_ENV=production/);
  });
});

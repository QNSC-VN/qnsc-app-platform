import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { inject } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { bootSpikeApp, type SpikeApp, type SpikeAppOptions } from '../../src/app';
import { SPIKE_JOBS_DDL } from '../../src/jobs/jobs-api';
import { MailSendWorker, type EmailMessage } from '../../src/jobs/mail';
import { Client } from './client';

export interface Stack extends SpikeApp {
  database: string;
  keyPrefix: string;
  pool: Pool;
  client(defaults?: Record<string, string>): Client;
  /** Run the worker until the queue is empty; returns the messages sent. */
  drainMail(): Promise<EmailMessage[]>;
  stop(): Promise<void>;
}

export type StackOptions = Partial<Pick<SpikeAppOptions, 'enqueueMode'>> & {
  /** Origins besides the app's own that Better Auth must trust (an IdP's, for OIDC discovery). */
  extraTrustedOrigins?: string[];
  identity?: Partial<SpikeAppOptions['identity']>;
  /** Override the Valkey URL (to point the app at a dead cache). */
  valkeyUrl?: string;
};

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

/** A fresh database + key prefix + app per call: files and tests never share state. */
export async function startStack(options: StackOptions = {}): Promise<Stack> {
  const database = `spike_${randomBytes(6).toString('hex')}`;
  const keyPrefix = `${database}:`;
  const admin = new Pool({ connectionString: inject('pgAdminUri') });
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.end();

  const env = {
    DATABASE_HOST: inject('pgHost'),
    DATABASE_PORT: String(inject('pgPort')),
    DATABASE_NAME: database,
    DATABASE_USER: inject('pgUser'),
    DATABASE_PASSWORD: inject('pgPassword'),
    DATABASE_SSL: 'disable',
    NODE_ENV: 'test',
  };

  // Migrate exactly as a product would: the committed drizzle-kit SQL, through Drizzle's migrator.
  const pool = new Pool({
    host: env.DATABASE_HOST,
    port: Number(env.DATABASE_PORT),
    database,
    user: env.DATABASE_USER,
    password: env.DATABASE_PASSWORD,
    max: 4,
  });
  const migrator = drizzle(pool);
  await migrate(migrator, { migrationsFolder: join(__dirname, '../../drizzle') });
  await migrator.execute(sql.raw(SPIKE_JOBS_DDL));
  await migrator.execute(sql.raw(MailSendWorker.LEDGER_DDL));

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const secret = randomBytes(32).toString('hex'); // generated per run; never committed
  const spike = await bootSpikeApp({
    env,
    valkeyUrl: options.valkeyUrl ?? inject('valkeyUrl'),
    keyPrefix,
    port,
    enqueueMode: options.enqueueMode ?? 'transactional',
    identity: {
      product: 'spike',
      baseURL: origin,
      secret,
      trustedOrigins: [origin, ...(options.extraTrustedOrigins ?? [])],
      presets: ['public'],
      ...options.identity,
    } as SpikeAppOptions['identity'],
  });

  return {
    ...spike,
    database,
    keyPrefix,
    pool,
    client: (defaults) => new Client(spike.url, defaults),
    drainMail: async () => {
      const before = spike.sender.sent.length;
      await spike.worker.drain();
      return spike.sender.sent.slice(before);
    },
    stop: async () => {
      await spike.close();
      await pool.end();
    },
  };
}

import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  dockerTestsEnabled,
  startPostgres,
  startValkey,
  type PostgresHarness,
  type ValkeyHarness,
} from '@quynhonsemiconductor/testing';
import { runIdentityConformance } from './testing';
import type { ConformanceInfra } from './testing';

/**
 * The package's own run of the conformance kit, against PostgreSQL 18 and Valkey from the shared
 * harness. A product runs the same `runIdentityConformance` against its own database and cache.
 */
const enabled = await dockerTestsEnabled();

describe.skipIf(!enabled)('identity conformance (package)', () => {
  let pg: PostgresHarness;
  let valkey: ValkeyHarness;
  const pools: Pool[] = [];

  const infra: ConformanceInfra = {
    async database() {
      const name = `conf_${randomBytes(6).toString('hex')}`;
      const admin = pg.createPool({ database: 'postgres', max: 1 });
      try {
        await admin.query(`CREATE DATABASE ${name}`);
      } finally {
        await admin.end();
      }
      const pool = pg.createPool({ database: name, max: 8 });
      pools.push(pool);
      return { pool, stop: () => pool.end() };
    },
    async valkey() {
      return { url: valkey.url, keyPrefix: `${randomBytes(6).toString('hex')}:` };
    },
  };

  beforeAll(async () => {
    [pg, valkey] = await Promise.all([startPostgres({ database: 'postgres' }), startValkey()]);
  }, 180_000);
  afterAll(async () => {
    // Pools first: stopping the container under a live pool turns teardown into unhandled errors.
    await Promise.allSettled(pools.map((pool) => pool.end()));
    await Promise.allSettled([pg?.stop(), valkey?.stop()]);
  });

  // Most kit tests start a database and an app of their own; under a full parallel `pnpm test`, with
  // several containers up, the runner's 5 s default is too tight. Give each one a minute.
  const slowIt = (name: string, fn: () => unknown, timeout = 60_000): void => {
    it(name, fn, timeout);
  };
  runIdentityConformance({ describe, it: slowIt, beforeAll, afterAll, expect }, infra);
});

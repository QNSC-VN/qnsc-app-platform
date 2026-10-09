import { createPool } from '@quynhonsemiconductor/platform-db';
import type { Pool } from 'pg';
import { DEFAULTS } from './config';
import type { JobsLogger } from './engine';

/**
 * The dedicated pool pg-boss runs on: `platform-db`'s `createPool` (verified TLS, the permanent
 * per-client error listener, named errors) with a small fixed size. pg-boss statements are short,
 * and a pool of its own keeps a burst of jobs from starving the API's connections, or the other
 * way round. The same `DATABASE_*` variables as the application pool, so the application role is
 * the one that is used.
 */
export function createJobsPool(env: NodeJS.ProcessEnv = process.env, logger?: JobsLogger): Pool {
  return createPool({ ...env, DB_POOL_MAX: String(DEFAULTS.poolMax) }, logger ? { logger } : {});
}

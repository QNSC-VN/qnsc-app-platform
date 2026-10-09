/**
 * `@quynhonsemiconductor/platform-db`
 *
 * The one PostgreSQL connection layer for QNSC product backends: password auth from the
 * CloudNativePG-generated Secret, TLS verified against the cluster CA, a sized pool, a
 * readiness ping, a Postgres leader lock, and the transaction contract.
 *
 * Subpaths:
 *   `@quynhonsemiconductor/platform-db/drizzle`  Drizzle instance, DbExecutor, withTransaction
 *   `@quynhonsemiconductor/platform-db/nest`     DatabaseModule
 *
 * This entry point is framework-agnostic and imports neither Drizzle nor Nest.
 */
export { DEFAULTS, readDatabaseConfig, type DatabaseConfig, type DatabaseEnv } from './config';
export {
  DatabaseConfigError,
  DatabaseConnectionError,
  classifyDatabaseError,
  type ConnectionTarget,
  type DatabaseErrorCode,
} from './errors';
export {
  createMigratorPool,
  createPool,
  createReadPool,
  type CreatePoolOptions,
  type DbLogger,
} from './pool';
export { pingDatabase } from './ping';
export { withAdvisoryLock, type AdvisoryLockResult } from './advisory-lock';
export { DATABASE_POOL_TOKEN, DATABASE_READ_POOL_TOKEN } from './tokens';

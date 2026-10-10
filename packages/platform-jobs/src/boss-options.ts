import type { Pool } from 'pg';
import { DEFAULTS } from './config';

export type Role = 'worker' | 'api';

/**
 * `ROLE=worker` is the only value that turns a process into a worker. Anything else, including
 * unset, is an API process: it can enqueue and nothing else. A typo therefore fails safe: a
 * mis-spelled worker does nothing visible instead of an API pod quietly running handlers.
 */
export function roleFrom(env: NodeJS.ProcessEnv = process.env): Role {
  return env['ROLE']?.trim().toLowerCase() === 'worker' ? 'worker' : 'api';
}

/**
 * The pg-boss constructor options. Everything here is FIXED by ADR 0001, not a knob:
 *
 * - `db`: pg-boss never opens a connection of its own. It borrows the pool from `platform-db`,
 *   which brings verified TLS, the permanent per-client error listener and named errors.
 * - `migrate: false`, `createSchema: false`: the application role never runs DDL. The migration
 *   Job installs the schema (`installJobsSchema`); against an older schema `start()` rejects
 *   instead of migrating (F8).
 * - `persistQueueStats: false`: it works for two days and then breaks supervision for a role
 *   that does not own the schema (F8, decision 1). Depth, failures and dead letters come from the
 *   OpenTelemetry metrics, the oldest-job age from `registerOldestReadyAge` (F9).
 * - `supervise` and `schedule` only for a worker: one supervisor is enough and API pods have no
 *   business expiring or retrying jobs.
 * - `superviseIntervalSeconds: 15`: the queue counts behind the depth gauge are only as fresh as
 *   this pass, and pg-boss's default of 60 s makes the alerts minutes late (F10).
 * - `maintenanceIntervalSeconds: 900`: pg-boss deletes finished jobs past their retention only
 *   this often, and its default is 24 hours; "kept at most 24 h" would otherwise mean 48.
 *
 * Returned untyped on purpose: the pg-boss type would leak into the published declarations.
 */
export function bossOptions(input: {
  role: Role;
  pool: Pool;
  instanceName?: string;
  superviseIntervalSeconds?: number;
  monitorIntervalSeconds?: number;
  maintenanceIntervalSeconds?: number;
}): Record<string, unknown> {
  const worker = input.role === 'worker';
  return {
    db: { executeSql: (text: string, values?: unknown[]) => input.pool.query(text, values) },
    schema: 'pgboss',
    migrate: false,
    createSchema: false,
    persistQueueStats: false,
    supervise: worker,
    schedule: worker,
    superviseIntervalSeconds: input.superviseIntervalSeconds ?? DEFAULTS.superviseIntervalSeconds,
    maintenanceIntervalSeconds:
      input.maintenanceIntervalSeconds ?? DEFAULTS.maintenanceIntervalSeconds,
    // `monitorIntervalSeconds` is left at pg-boss's 60 s on purpose: it gates job EXPIRY and
    // HEARTBEAT failure per queue, so it bounds how soon a dead worker's job is noticed (see the
    // README). Only a test shortens it.
    ...(input.monitorIntervalSeconds !== undefined
      ? { monitorIntervalSeconds: input.monitorIntervalSeconds }
      : {}),
    ...(input.instanceName ? { instanceName: input.instanceName } : {}),
  };
}

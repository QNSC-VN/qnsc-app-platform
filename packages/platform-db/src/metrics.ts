import type { Pool } from 'pg';
import { DbPoolMetrics } from '@quynhonsemiconductor/observability';

/**
 * Report the pool's saturation (`inUse`, `waiting`) through OpenTelemetry. Pool saturation is
 * the usual cause of a latency cliff: requests queue for a connection while every individual
 * query still looks fast.
 *
 * Pull-based: OTel reads the live pool on each collection, so there is no timer to own.
 * Idempotent per `DbPoolMetrics` instance.
 */
export function registerPoolMetrics(
  pool: Pool,
  metrics: DbPoolMetrics = new DbPoolMetrics(),
): void {
  metrics.register(() => ({
    inUse: pool.totalCount - pool.idleCount,
    waiting: pool.waitingCount,
  }));
}

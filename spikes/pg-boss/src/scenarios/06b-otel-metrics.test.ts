import { dockerTestsEnabled } from '@quynhonsemiconductor/testing';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBoss, ensureQueues, type SpikeBoss } from '../support/boss.ts';
import { startCluster, type Cluster } from '../support/cluster.ts';
import { recordResult } from '../support/results.ts';
import { waitFor } from '../support/wait.ts';

/**
 * Scenario 6, second path. A Grafana Cloud workspace cannot open a connection into a private
 * CloudNativePG cluster, so the panel data a product actually ships to Grafana Cloud has to leave
 * as OpenTelemetry metrics through Alloy, from the worker. pg-boss emits those itself
 * (`openTelemetry` option, on by default and free until an SDK is registered). This checks which
 * instruments it emits and that their values are right, so WP-7 knows what `observability` has
 * to add and what it gets for free.
 */
const enabled = await dockerTestsEnabled();

describe.skipIf(!enabled)('scenario 6 — the same facts as OpenTelemetry metrics', () => {
  let cluster: Cluster;
  let boss: SpikeBoss;
  let reader: PeriodicExportingMetricReader;
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);

  beforeAll(async () => {
    cluster = await startCluster();
    reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 1_000 });
    // sdk-metrics 2.x takes its readers in the constructor.
    const mp = new MeterProvider({ readers: [reader] });
    boss = createBoss(cluster.pool(6), {
      schedule: false,
      // The depth gauge reads counts that only a supervise pass refreshes: with the default
      // superviseIntervalSeconds (60) it would lag a minute whatever the other two say.
      superviseIntervalSeconds: 2,
      queueCacheIntervalSeconds: 2,
      monitorIntervalSeconds: 2,
      openTelemetry: { meterProvider: mp },
    });
    await boss.start();
    await ensureQueues(boss, [
      { name: 'otel.dlq' },
      { name: 'otel.fail', retryLimit: 0, deadLetter: 'otel.dlq' },
      { name: 'otel.idle' },
      { name: 'otel.ok' },
    ]);
  });
  afterAll(async () => {
    await boss?.stop({ graceful: true, timeout: 5_000 });
    await reader?.shutdown().catch(() => undefined);
    await cluster?.stop();
  });

  interface Point {
    attributes: Record<string, unknown>;
    value: unknown;
  }
  // Cumulative temporality: every export repeats the running totals, so read the latest export only.
  const points = (name: string): Point[] =>
    exporter
      .getMetrics()
      .slice(-1)
      .flatMap((rm) =>
        rm.scopeMetrics.flatMap((sm) =>
          sm.metrics
            .filter((m) => m.descriptor.name === name)
            .flatMap((m) => m.dataPoints as unknown as Point[]),
        ),
      );

  it('emits depth by state, sent/consumed counters and processing duration with correct values', async () => {
    await boss.work('otel.ok', { pollingIntervalSeconds: 0.5 }, async () => undefined);
    await boss.work('otel.fail', { pollingIntervalSeconds: 0.5 }, async () => {
      throw new Error('boom');
    });
    for (let i = 0; i < 7; i++) await boss.send('otel.idle', { i });
    for (let i = 0; i < 4; i++) await boss.send('otel.ok', { i });
    for (let i = 0; i < 3; i++) await boss.send('otel.fail', { i });

    const names = () =>
      new Set(
        exporter
          .getMetrics()
          .slice(-1)
          .flatMap((rm) =>
            rm.scopeMetrics.flatMap((sm) => sm.metrics.map((m) => m.descriptor.name)),
          ),
      );
    await waitFor(() => names().has('pgboss.queue.jobs') || undefined, 'the depth gauge', {
      timeoutMs: 30_000,
      intervalMs: 500,
    });

    // One data point per (queue, state): the 7 idle jobs are `ready`.
    const gauge = await waitFor(
      () => {
        const idle = points('pgboss.queue.jobs').filter(
          (p) => p.attributes['messaging.destination.name'] === 'otel.idle',
        );
        return idle.some(
          (p) => p.attributes['pgboss.job.state'] === 'ready' && Number(p.value) === 7,
        )
          ? idle
          : undefined;
      },
      'otel.idle to report 7 ready jobs',
      { timeoutMs: 30_000, intervalMs: 500 },
    );
    const attributeKeys = Object.keys(gauge[0]!.attributes).sort();

    const sent = points('messaging.client.sent.messages')
      .filter((p) => String(p.attributes['messaging.destination.name']).startsWith('otel.'))
      .reduce((a, p) => a + Number(p.value), 0);
    expect(sent).toBe(14); // 7 idle + 4 ok + 3 fail, and nothing pg-boss sent to itself

    await waitFor(
      () => points('messaging.process.duration').length > 0 || undefined,
      'process duration',
      { timeoutMs: 20_000, intervalMs: 500 },
    );
    const failedProcess = points('messaging.process.duration').filter(
      (p) => 'error.type' in p.attributes,
    );

    recordResult('scenario-6', {
      otel: {
        instruments: [...names()].sort(),
        queueJobsAttributeKeys: attributeKeys,
        queueJobsIdleValue: 7,
        sentMessagesToTestQueues: sent,
        processDurationSeriesWithErrorType: failedProcess.length,
        resolutionSeconds: 2,
      },
    });
    expect(names()).toContain('pgboss.queue.jobs');
    expect(names()).toContain('messaging.client.sent.messages');
    expect(names()).toContain('messaging.process.duration');
    expect(
      failedProcess.length,
      'failed processing is not distinguishable in the duration metric',
    ).toBeGreaterThan(0);
  });
});

import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { bossOptions, roleFrom } from './boss-options';

const pool = { query: vi.fn() } as unknown as Pool;

describe('roleFrom', () => {
  it('ROLE=worker is a worker, case and space insensitive', () => {
    expect(roleFrom({ ROLE: 'worker' })).toBe('worker');
    expect(roleFrom({ ROLE: ' Worker ' })).toBe('worker');
  });
  it.each([undefined, '', 'api', 'workers', 'wroker'])(
    'anything else (%j) only enqueues',
    (value) => {
      expect(roleFrom(value === undefined ? {} : { ROLE: value })).toBe('api');
    },
  );
});

describe('the pg-boss options are fixed by ADR 0001, not configurable', () => {
  it.each(['worker', 'api'] as const)(
    'as %s: never DDL, never persistQueueStats, supervise every 15 s',
    (role) => {
      const options = bossOptions({ role, pool });
      expect(options).toMatchObject({
        schema: 'pgboss',
        migrate: false,
        createSchema: false,
        persistQueueStats: false,
        superviseIntervalSeconds: 15,
      });
    },
  );

  it('a worker supervises and schedules; an API process does neither', () => {
    expect(bossOptions({ role: 'worker', pool })).toMatchObject({
      supervise: true,
      schedule: true,
    });
    expect(bossOptions({ role: 'api', pool })).toMatchObject({ supervise: false, schedule: false });
  });

  it('borrows the platform-db pool and opens no connection of its own', () => {
    const options = bossOptions({ role: 'api', pool }) as {
      db: { executeSql: unknown };
      host?: unknown;
      connectionString?: unknown;
    };
    expect(typeof options.db.executeSql).toBe('function');
    expect(options.host).toBeUndefined();
    expect(options.connectionString).toBeUndefined();
  });

  it('runs its SQL through that pool', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const options = bossOptions({ role: 'api', pool: { query } as unknown as Pool }) as {
      db: { executeSql(text: string, values?: unknown[]): Promise<unknown> };
    };
    await options.db.executeSql('SELECT $1', [1]);
    expect(query).toHaveBeenCalledWith('SELECT $1', [1]);
  });

  it('names the instance after the service when it has a name', () => {
    expect(bossOptions({ role: 'worker', pool, instanceName: 'lms-worker' })).toMatchObject({
      instanceName: 'lms-worker',
    });
  });
});

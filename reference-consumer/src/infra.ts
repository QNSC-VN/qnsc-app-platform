import { CacheModule, CacheService } from '@quynhonsemiconductor/platform-cache';
import type { Redis } from 'ioredis';
import { DatabaseModule } from '@quynhonsemiconductor/platform-db/nest';
import { JobsModule } from '@quynhonsemiconductor/platform-jobs/nest';
import { createValkeyMailState } from '@quynhonsemiconductor/platform-mail';
import { MailModule } from '@quynhonsemiconductor/platform-mail/nest';
import { loggerModule } from './logging';
import * as schema from './schema';

/**
 * WORKAROUND for a gap in the published packages (reported in the M6 issues).
 *
 * `platform-mail`'s README wires the ledger as `createValkeyMailState(cache.instance)` inside
 * `useFactory`. That throws at boot ("client is not available"): `CacheService` creates its client in
 * `onModuleInit`, which Nest runs AFTER every provider, including this factory, is built. The client is
 * therefore looked up on first use instead of at construction.
 */
const lazyRedis = (cache: CacheService): Redis =>
  new Proxy({} as Redis, {
    get: (_target, property) => {
      const value = (cache.instance as unknown as Record<PropertyKey, unknown>)[property];
      return typeof value === 'function' ? value.bind(cache.instance) : value;
    },
  });

/**
 * What the API and the worker share: logger, cache, database, jobs, mail. Nothing here is a stand-in:
 * `JobsModule` is platform-jobs on pg-boss, `MailModule` is platform-mail with its Valkey ledger and
 * the `smtp` transport, both from the registry. Configuration is the environment only.
 */
export const infraImports = (service: string) => [
  loggerModule(service),
  CacheModule.forRoot({ url: process.env['REDIS_URL'], keyPrefix: 'm6:', mode: 'required' }),
  DatabaseModule.forRootAsync({ schema }),
  JobsModule.forRoot(),
  MailModule.forRootAsync({
    inject: [CacheService],
    useFactory: (cache: CacheService) => ({ state: createValkeyMailState(lazyRedis(cache)) }),
  }),
];

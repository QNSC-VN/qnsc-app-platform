import type { TestProject } from 'vitest/node';
// Not part of `tsc -p tsconfig.json`: the shared harness is workspace TypeScript compiled for a
// bundler, and vitest runs it as is. See tsconfig.json `exclude`.
import { startPostgres, startValkey } from '../../../../packages/testing/src';

/** One PostgreSQL 18 and one Valkey for the whole run, from the repo's own testing harness. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const [pg, valkey] = await Promise.all([startPostgres({ database: 'postgres' }), startValkey()]);
  project.provide('pgAdminUri', pg.uri);
  project.provide('pgHost', pg.host);
  project.provide('pgPort', pg.port);
  project.provide('pgUser', pg.user);
  project.provide('pgPassword', pg.password);
  project.provide('valkeyUrl', valkey.url);
  project.provide('valkeyHost', valkey.host);
  project.provide('valkeyPort', valkey.port);
  return async () => {
    await Promise.allSettled([pg.stop(), valkey.stop()]);
  };
}

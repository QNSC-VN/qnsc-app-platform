/**
 * The `/nest` subpath needs `@quynhonsemiconductor/observability` (pool saturation gauges) and
 * `drizzle-orm`, which are OPTIONAL peers because the core and `/drizzle` need at most the
 * latter. A missing one would otherwise surface as a bare `Cannot find module` from deep inside
 * this package; say what to install instead.
 *
 * Imported FIRST by `nest/index.ts`: compiled CommonJS runs imports in order, so this throws
 * before the module that needs the peer is loaded.
 */
for (const peer of ['@quynhonsemiconductor/observability', 'drizzle-orm', '@nestjs/common']) {
  try {
    // `require` is absent when a bundler or test runner loads this as ESM; their own resolver
    // reports a missing module well enough.
    if (typeof require !== 'undefined') require.resolve(peer);
  } catch {
    throw new Error(
      `@quynhonsemiconductor/platform-db/nest requires "${peer}" to be installed. ` +
        'Add it to your dependencies (the core entry point and /drizzle do not need ' +
        '@quynhonsemiconductor/observability).',
    );
  }
}

/**
 * The `/nest` subpath needs three OPTIONAL peers: `@quynhonsemiconductor/observability` (pool
 * saturation gauges), `drizzle-orm` and `@nestjs/common`. They are optional because no single
 * one is needed by every entry point (the core needs none of them). A missing one would
 * otherwise surface as a bare `Cannot find module` from deep inside this package; say what to
 * install instead.
 */

/** Each peer `/nest` needs, and which other entry points need it too. */
export const NEST_PEERS = [
  {
    name: '@quynhonsemiconductor/observability',
    note: 'Only /nest needs it (pool saturation gauges); the core entry point and /drizzle do not.',
  },
  {
    name: 'drizzle-orm',
    note: '/drizzle needs it too; the core entry point does not.',
  },
  {
    name: '@nestjs/common',
    note: 'Only /nest needs it.',
  },
] as const;

export function missingPeerMessage(peer: (typeof NEST_PEERS)[number]): string {
  return (
    `@quynhonsemiconductor/platform-db/nest requires "${peer.name}" to be installed. ` +
    `Add it to your dependencies. ${peer.note}`
  );
}

/**
 * Throw naming the first peer that `resolve` cannot find. `resolve` is injected so the message
 * can be tested without uninstalling anything.
 */
export function assertNestPeers(resolve: (id: string) => unknown): void {
  for (const peer of NEST_PEERS) {
    try {
      resolve(peer.name);
    } catch {
      throw new Error(missingPeerMessage(peer));
    }
  }
}

// Run when `nest/index.ts` imports this FIRST: compiled CommonJS runs imports in order, so it
// throws before the module that needs the peer is loaded. `require` is absent when a bundler or
// test runner loads this as ESM; their own resolver reports a missing module well enough.
if (typeof require !== 'undefined') assertNestPeers((id) => require.resolve(id));

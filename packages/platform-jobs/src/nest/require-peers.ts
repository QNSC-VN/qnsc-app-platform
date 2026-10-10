/**
 * The `/nest` subpath needs `@nestjs/common` and `@nestjs/core` (provider discovery), which are
 * OPTIONAL peers because the core entry point needs neither. A missing one would otherwise surface
 * as a bare `Cannot find module` from deep inside this package; say what to install instead.
 */
export const NEST_PEERS = ['@nestjs/common', '@nestjs/core'] as const;

export function missingPeerMessage(peer: string): string {
  return (
    `@quynhonsemiconductor/platform-jobs/nest requires "${peer}" to be installed. ` +
    'Add it to your dependencies; the core entry point does not need it.'
  );
}

/** `resolve` is injected so the message can be tested without uninstalling anything. */
export function assertNestPeers(resolve: (id: string) => unknown): void {
  for (const peer of NEST_PEERS) {
    try {
      resolve(peer);
    } catch {
      throw new Error(missingPeerMessage(peer));
    }
  }
}

// Imported FIRST by `nest/index.ts`: compiled CommonJS runs imports in order, so this throws before
// the module that needs the peer is loaded. `require` is absent when a bundler or test runner
// loads this as ESM; their own resolver reports a missing module well enough.
if (typeof require !== 'undefined') assertNestPeers((id) => require.resolve(id));

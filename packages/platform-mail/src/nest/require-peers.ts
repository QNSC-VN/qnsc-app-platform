/**
 * The `/nest` subpath needs `@nestjs/common`, which is an OPTIONAL peer because the core entry
 * point (and `/testing`) need no framework. Without this, a missing one surfaces as a bare
 * `Cannot find module` from deep inside the package; say what to install instead.
 */
export function missingPeerMessage(name: string): string {
  return (
    `@quynhonsemiconductor/platform-mail/nest requires "${name}" to be installed. ` +
    'Add it to your dependencies. Only /nest needs it; the core entry point does not.'
  );
}

/** Throw naming the first peer `resolve` cannot find. `resolve` is injected so this is testable. */
export function assertNestPeers(resolve: (id: string) => unknown): void {
  try {
    resolve('@nestjs/common');
  } catch {
    throw new Error(missingPeerMessage('@nestjs/common'));
  }
}

// Run when `nest/index.ts` imports this FIRST: compiled CommonJS runs imports in order. `require`
// is absent when a bundler or test runner loads this as ESM; their resolver reports it well enough.
if (typeof require !== 'undefined') assertNestPeers((id) => require.resolve(id));

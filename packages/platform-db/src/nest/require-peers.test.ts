import { describe, expect, it } from 'vitest';
import { assertNestPeers, missingPeerMessage, NEST_PEERS } from './require-peers';

/** A resolver that finds everything except `missing`. */
const resolverMissing = (missing: string) => (id: string) => {
  if (id === missing) throw new Error(`Cannot find module '${id}'`);
  return `/node_modules/${id}`;
};

describe('assertNestPeers', () => {
  it('passes when every peer resolves', () => {
    expect(() => assertNestPeers((id) => `/node_modules/${id}`)).not.toThrow();
  });

  it.each(NEST_PEERS.map((p) => [p.name]))('names %s when it is missing', (name) => {
    expect(() => assertNestPeers(resolverMissing(name))).toThrow(
      `@quynhonsemiconductor/platform-db/nest requires "${name}" to be installed.`,
    );
  });

  it('tells the reader to install it, not just that it is absent', () => {
    expect(() => assertNestPeers(resolverMissing('drizzle-orm'))).toThrow(
      /Add it to your dependencies/,
    );
  });

  it('is accurate about which other entry points need the peer', () => {
    // drizzle-orm IS needed by /drizzle; observability is NOT. The old message said the
    // opposite for drizzle-orm.
    expect(() => assertNestPeers(resolverMissing('drizzle-orm'))).toThrow(/\/drizzle needs it too/);
    expect(() => assertNestPeers(resolverMissing('@quynhonsemiconductor/observability'))).toThrow(
      /the core entry point and \/drizzle do not/,
    );
  });

  it('reports the first missing peer when several are missing', () => {
    const none = () => {
      throw new Error('nothing resolves');
    };
    expect(() => assertNestPeers(none)).toThrow(missingPeerMessage(NEST_PEERS[0]));
  });

  it('lists exactly the peers the README and package.json promise', () => {
    expect(NEST_PEERS.map((p) => p.name)).toEqual([
      '@quynhonsemiconductor/observability',
      'drizzle-orm',
      '@nestjs/common',
    ]);
  });
});

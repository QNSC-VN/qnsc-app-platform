import { describe, expect, it } from 'vitest';
import { assertNestPeers, missingPeerMessage, NEST_PEERS } from './require-peers';

const resolverMissing = (missing: string) => (id: string) => {
  if (id === missing) throw new Error(`Cannot find module '${id}'`);
  return `/node_modules/${id}`;
};

describe('assertNestPeers', () => {
  it('passes when every peer resolves', () => {
    expect(() => assertNestPeers((id) => `/node_modules/${id}`)).not.toThrow();
  });

  it.each(NEST_PEERS.map((p) => [p]))('names %s when it is missing', (name) => {
    expect(() => assertNestPeers(resolverMissing(name))).toThrow(
      `@quynhonsemiconductor/platform-jobs/nest requires "${name}" to be installed.`,
    );
  });

  it('tells the reader what to do and that the core does not need it', () => {
    expect(() => assertNestPeers(resolverMissing('@nestjs/core'))).toThrow(
      /Add it to your dependencies; the core entry point does not need it/,
    );
  });

  it('reports the first missing peer when several are missing', () => {
    const none = () => {
      throw new Error('nothing resolves');
    };
    expect(() => assertNestPeers(none)).toThrow(missingPeerMessage(NEST_PEERS[0]));
  });
});

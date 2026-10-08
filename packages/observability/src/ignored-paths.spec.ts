import { describe, expect, it } from 'vitest';
import { IGNORED_REQUEST_PATHS, PROBE_PATHS, isIgnoredRequestPath } from './ignored-paths';

describe('PROBE_PATHS', () => {
  it('lists every probe the kubelet or an ECS/EKS load balancer can hit', () => {
    expect([...PROBE_PATHS].sort()).toEqual(
      ['/healthz', '/livez', '/readyz', '/v1/healthz', '/v1/readyz'].sort(),
    );
  });

  it('cannot be mutated by a consumer', () => {
    expect(Object.isFrozen(PROBE_PATHS)).toBe(true);
  });

  it('is the source of IGNORED_REQUEST_PATHS, so the two cannot drift', () => {
    for (const path of PROBE_PATHS) expect(IGNORED_REQUEST_PATHS.has(path)).toBe(true);
    // ...and nothing but browser chrome is added on top.
    expect([...IGNORED_REQUEST_PATHS].filter((p) => !PROBE_PATHS.includes(p))).toEqual([
      '/favicon.ico',
    ]);
  });
});

describe('isIgnoredRequestPath', () => {
  it.each([...PROBE_PATHS, '/favicon.ico'])('ignores %s', (path) => {
    expect(isIgnoredRequestPath(path)).toBe(true);
  });

  it('ignores a probe that carries a query string', () => {
    expect(isIgnoredRequestPath('/livez?verbose=1')).toBe(true);
  });

  it.each(['/livez/deep', '/v1/users', '/readyz-extra', '/', ''])(
    'keeps %o visible — whole path match, never a prefix',
    (path) => {
      expect(isIgnoredRequestPath(path)).toBe(false);
    },
  );

  it('treats a missing url as not ignorable', () => {
    expect(isIgnoredRequestPath(undefined)).toBe(false);
  });
});

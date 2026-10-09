import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every releasable package must be wired into BOTH release-please and the publish
 * workflow.
 *
 * This exists because it was missed. `platform-runtime` was registered in
 * `release-please-config.json` but not added to `publish.yml`'s tag allowlist, so
 * release-please computed the version, tagged `platform-runtime-v0.1.1`, and cut a
 * GitHub Release — and no workflow fired. Nothing failed. The package simply was
 * not on the registry, which only surfaced when a consumer tried to install it.
 *
 * That is the same "real in three places, forgotten in the fourth" failure this org
 * already writes down for env vars, and a silent one: the allowlist is deliberate
 * (the workflow holds publish credentials), so it cannot be replaced with a wildcard
 * and will keep needing a manual edit per package. This test is the reminder.
 */
const root = join(import.meta.dirname, '..');

describe('release wiring', () => {
  const config = JSON.parse(readFileSync(join(root, 'release-please-config.json'), 'utf8')) as {
    packages: Record<string, { component: string }>;
  };
  const manifest = JSON.parse(
    readFileSync(join(root, '.release-please-manifest.json'), 'utf8'),
  ) as Record<string, string>;
  const publishWorkflow = readFileSync(join(root, '.github/workflows/publish.yml'), 'utf8');

  const entries = Object.entries(config.packages);

  it.each(entries)('%s has a publish tag pattern', (_dir, pkg) => {
    // The workflow resolves `packages/<component>` from the tag, so the pattern and
    // the component name have to agree exactly.
    expect(publishWorkflow).toContain(`'${pkg.component}-v*'`);
  });

  it.each(entries)('%s has a manifest entry', (dir) => {
    // Without one, release-please treats the package as brand new on every run and
    // cannot compute the next version.
    expect(manifest[dir]).toBeTypeOf('string');
  });

  it('has no manifest entry for a package release-please does not know about', () => {
    // The reverse drift: a stale entry left behind after a package is removed.
    expect(Object.keys(manifest).sort()).toEqual(Object.keys(config.packages).sort());
  });
});

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs helpers, no declaration file
import { linkManifest } from './link.mjs';
// @ts-expect-error -- plain .mjs helpers, no declaration file
import { changedPackageDirs, findManifests, listPackages } from './packages.mjs';

const repo = join(import.meta.dirname, '..', '..');
const scratch = mkdtempSync(join(tmpdir(), 'consumer-ci-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('linkManifest', () => {
  const tarballs = new Map([
    ['@quynhonsemiconductor/identity', '/t/identity.tgz'],
    ['@quynhonsemiconductor/platform-http', '/t/http.tgz'],
  ]);

  it('points dependencies, devDependencies and optionalDependencies at the tarball', () => {
    const json = {
      dependencies: { '@quynhonsemiconductor/identity': '^7.1.0', zod: '^4.0.0' },
      devDependencies: { '@quynhonsemiconductor/platform-http': '^4.0.0' },
      optionalDependencies: { '@quynhonsemiconductor/identity': '^7.0.0' },
    };
    const changed = linkManifest(json, tarballs);
    expect(json.dependencies['@quynhonsemiconductor/identity']).toBe('file:/t/identity.tgz');
    expect(json.devDependencies['@quynhonsemiconductor/platform-http']).toBe('file:/t/http.tgz');
    expect(json.optionalDependencies['@quynhonsemiconductor/identity']).toBe(
      'file:/t/identity.tgz',
    );
    expect(json.dependencies.zod).toBe('^4.0.0');
    expect(changed).toHaveLength(3);
  });

  it('leaves peerDependencies untouched: they are the range the product accepts', () => {
    const json = { peerDependencies: { '@quynhonsemiconductor/identity': '>=7' } };
    expect(linkManifest(json, tarballs)).toEqual([]);
    expect(json.peerDependencies['@quynhonsemiconductor/identity']).toBe('>=7');
  });

  it('ignores packages it has no tarball for', () => {
    const json = { dependencies: { '@quynhonsemiconductor/other': '^1.0.0' } };
    expect(linkManifest(json, tarballs)).toEqual([]);
  });
});

describe('listPackages', () => {
  const packages = listPackages(repo);

  it('lists the published packages and never the private testing harness', () => {
    const names = packages.map((p: { name: string }) => p.name);
    expect(names).toContain('@quynhonsemiconductor/platform-cache');
    expect(names).not.toContain('@quynhonsemiconductor/testing');
  });
});

describe('findManifests', () => {
  it('walks the tree but skips node_modules and .git', () => {
    const root = join(scratch, 'walk');
    for (const dir of ['', 'apps/web', 'node_modules/dep', '.git/x']) {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, 'package.json'), '{}');
    }
    const found = findManifests(root)
      .map((f: string) => f.slice(root.length + 1))
      .sort();
    expect(found).toEqual(['apps/web/package.json', 'package.json']);
  });
});

describe('changedPackageDirs', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
      cwd,
      encoding: 'utf8',
    });
  const all = [{ dir: 'a' }, { dir: 'b' }, { dir: 'c' }];

  function repoWith(change: string): string {
    const root = mkdtempSync(join(scratch, 'git-'));
    git(root, 'init', '-q', '-b', 'main');
    for (const f of [
      'packages/a/x.ts',
      'packages/b/x.ts',
      'packages/c/x.ts',
      'tsconfig.base.json',
    ]) {
      mkdirSync(join(root, f, '..'), { recursive: true });
      writeFileSync(join(root, f), '1');
    }
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'base');
    git(root, 'checkout', '-q', '-b', 'pr');
    writeFileSync(join(root, change), '2');
    git(root, 'commit', '-qam', 'change');
    return root;
  }

  it('returns only the packages whose directory changed', () => {
    expect(changedPackageDirs(repoWith('packages/b/x.ts'), 'main', all)).toEqual(['b']);
  });

  it('treats a change to a shared build input as changing every package', () => {
    expect(changedPackageDirs(repoWith('tsconfig.base.json'), 'main', all)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
});

describe('pack.mjs', () => {
  it('packs a canary with the suffixed version and restores package.json', () => {
    const out = join(scratch, 'canary');
    const before = readFileSync(join(repo, 'packages/platform-cache/package.json'), 'utf8');
    execFileSync('node', ['tools/consumer-ci/pack.mjs', '--out', out, '--canary', 'pr.7.abcdef0'], {
      cwd: repo,
      encoding: 'utf8',
    });
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as {
      name: string;
      version: string;
      file: string;
    }[];
    const cache = manifest.find((m) => m.name === '@quynhonsemiconductor/platform-cache');
    expect(cache?.version).toMatch(/^\d+\.\d+\.\d+-pr\.7\.abcdef0$/);
    expect(cache?.file).toContain(cache?.version);
    expect(readFileSync(join(repo, 'packages/platform-cache/package.json'), 'utf8')).toBe(before);
  }, 120_000);

  it('rejects a canary label that is not pr.<number>.<sha7>', () => {
    expect(() =>
      execFileSync(
        'node',
        ['tools/consumer-ci/pack.mjs', '--out', join(scratch, 'bad'), '--canary', 'latest'],
        {
          cwd: repo,
          stdio: 'pipe',
        },
      ),
    ).toThrow();
  });
});

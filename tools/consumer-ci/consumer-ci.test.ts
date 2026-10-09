import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs helpers, no declaration file
import { linkManifest } from './link.mjs';
// @ts-expect-error -- plain .mjs helpers, no declaration file
import {
  changedPackageDirs,
  commitMessages,
  findManifests,
  isBreaking,
  listPackages,
  releaseVersion,
} from './packages.mjs';

const repo = join(import.meta.dirname, '..', '..');
const scratch = mkdtempSync(join(tmpdir(), 'consumer-ci-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('linkManifest', () => {
  const tarballs = new Map([
    ['@quynhonsemiconductor/identity', { file: '/t/identity.tgz', version: '7.1.0' }],
    ['@quynhonsemiconductor/platform-http', { file: '/t/http.tgz', version: '4.1.0' }],
  ]);

  it('links dependencies, devDependencies and optionalDependencies whose range the tarball satisfies', () => {
    const json = {
      dependencies: { '@quynhonsemiconductor/identity': '^7.0.0', zod: '^4.0.0' },
      devDependencies: { '@quynhonsemiconductor/platform-http': '^4.0.0' },
      optionalDependencies: { '@quynhonsemiconductor/identity': '>=7' },
    };
    const { linked, skipped } = linkManifest(json, tarballs);
    expect(json.dependencies['@quynhonsemiconductor/identity']).toBe('file:/t/identity.tgz');
    expect(json.devDependencies['@quynhonsemiconductor/platform-http']).toBe('file:/t/http.tgz');
    expect(json.optionalDependencies['@quynhonsemiconductor/identity']).toBe(
      'file:/t/identity.tgz',
    );
    expect(json.dependencies.zod).toBe('^4.0.0');
    expect(linked).toHaveLength(3);
    expect(skipped).toEqual([]);
  });

  it('skips a dependency whose declared range the tarball is outside of, and leaves it alone', () => {
    const major = new Map([
      ['@quynhonsemiconductor/identity', { file: '/t/identity-8.tgz', version: '8.0.0' }],
    ]);
    const json = { dependencies: { '@quynhonsemiconductor/identity': '^7.1.0' } };
    const { linked, skipped } = linkManifest(json, major);
    expect(linked).toEqual([]);
    expect(skipped).toEqual([
      { name: '@quynhonsemiconductor/identity', version: '8.0.0', range: '^7.1.0' },
    ]);
    expect(json.dependencies['@quynhonsemiconductor/identity']).toBe('^7.1.0');
  });

  it('links what applies and skips what does not, in the same manifest', () => {
    const mixed = new Map([
      ['@quynhonsemiconductor/identity', { file: '/t/identity-8.tgz', version: '8.0.0' }],
      ['@quynhonsemiconductor/platform-http', { file: '/t/http.tgz', version: '4.1.0' }],
    ]);
    const json = {
      dependencies: {
        '@quynhonsemiconductor/identity': '^7.1.0',
        '@quynhonsemiconductor/platform-http': '^4.0.0',
      },
    };
    const { linked, skipped } = linkManifest(json, mixed);
    expect(linked).toEqual(['@quynhonsemiconductor/platform-http']);
    expect(skipped.map((x: { name: string }) => x.name)).toEqual([
      '@quynhonsemiconductor/identity',
    ]);
  });

  it('links a range semver cannot parse: there is no range to be outside of', () => {
    const json = { dependencies: { '@quynhonsemiconductor/identity': 'latest' } };
    expect(linkManifest(json, tarballs).linked).toHaveLength(1);
  });

  it('leaves peerDependencies untouched: they are the range the product accepts', () => {
    const json = { peerDependencies: { '@quynhonsemiconductor/identity': '>=7' } };
    expect(linkManifest(json, tarballs)).toEqual({ linked: [], skipped: [] });
    expect(json.peerDependencies['@quynhonsemiconductor/identity']).toBe('>=7');
  });

  it('ignores packages it has no tarball for', () => {
    const json = { dependencies: { '@quynhonsemiconductor/other': '^1.0.0' } };
    expect(linkManifest(json, tarballs)).toEqual({ linked: [], skipped: [] });
  });
});

describe('link.mjs (the command the consumer jobs run)', () => {
  /** A product with one package.json, and a tarballs dir whose manifest says identity is `version`. */
  function fixture(opts: { declared: Record<string, string>; version: string }) {
    const dir = mkdtempSync(join(scratch, 'link-'));
    const product = join(dir, 'product');
    const tarballs = join(dir, 'tarballs');
    mkdirSync(product, { recursive: true });
    mkdirSync(tarballs, { recursive: true });
    writeFileSync(
      join(product, 'package.json'),
      JSON.stringify({ name: 'p', dependencies: opts.declared }),
    );
    writeFileSync(
      join(tarballs, 'manifest.json'),
      JSON.stringify([
        {
          name: '@quynhonsemiconductor/identity',
          dir: 'identity',
          version: opts.version,
          file: `identity-${opts.version}.tgz`,
        },
      ]),
    );
    const output = join(dir, 'github-output');
    writeFileSync(output, '');
    const run = () =>
      spawnSync(
        'node',
        ['tools/consumer-ci/link.mjs', '--product', product, '--tarballs', tarballs],
        {
          cwd: repo,
          encoding: 'utf8',
          env: { ...process.env, GITHUB_OUTPUT: output },
        },
      );
    return { run, product, output };
  }

  it('links an in-range dependency and reports the product as applicable', () => {
    const f = fixture({
      declared: { '@quynhonsemiconductor/identity': '^7.1.0' },
      version: '7.2.0',
    });
    const result = f.run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('linked @quynhonsemiconductor/identity');
    expect(readFileSync(join(f.product, 'package.json'), 'utf8')).toContain('file:');
    expect(readFileSync(f.output, 'utf8')).toBe('applicable=true\n');
  });

  it('skips an out-of-range dependency with the "not applicable" note', () => {
    const f = fixture({
      declared: { '@quynhonsemiconductor/identity': '^7.1.0' },
      version: '8.0.0',
    });
    const result = f.run();
    expect(result.stdout).toContain('not applicable: identity@8.0.0 outside ^7.1.0');
    expect(readFileSync(join(f.product, 'package.json'), 'utf8')).not.toContain('file:');
  });

  it('PASSES when every dependency is out of range, and says nothing applies', () => {
    const f = fixture({
      declared: { '@quynhonsemiconductor/identity': '^7.1.0' },
      version: '8.0.0',
    });
    const result = f.run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Nothing in this pull request applies to this product');
    expect(readFileSync(f.output, 'utf8')).toBe('applicable=false\n');
  });

  it('FAILS when the product depends on none of our packages: that is not "nothing applies"', () => {
    const f = fixture({ declared: { zod: '^4.0.0' }, version: '7.1.0' });
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('No dependency on');
    expect(readFileSync(f.output, 'utf8')).toBe('');
  });
});

describe('isBreaking / releaseVersion', () => {
  it.each([
    ['feat(identity)!: rebuild on Better Auth', true],
    ['fix!: drop a field', true],
    ['feat: add a thing\n\nBREAKING CHANGE: the old thing is gone', true],
    ['feat: add a thing\n\nBREAKING-CHANGE: the old thing is gone', true],
    ['feat(identity): add a thing', false],
    ['fix: handle the bang! case', false],
    ['docs: mention BREAKING CHANGE in prose', false],
  ])('%j -> breaking=%s', (message, expected) => {
    expect(isBreaking(message)).toBe(expected);
  });

  it('gives a breaking change the next major, so a product on the old major is not tested against it', () => {
    expect(releaseVersion('7.1.0', ['feat(identity)!: x'])).toBe('8.0.0');
  });

  it('gives a breaking change below 1.0.0 the next minor (bump-minor-pre-major)', () => {
    expect(releaseVersion('0.2.1', ['feat!: x'])).toBe('0.3.0');
  });

  it('keeps the current version for anything that cannot leave a caret range', () => {
    expect(releaseVersion('7.1.0', ['feat: x', 'fix: y'])).toBe('7.1.0');
    expect(releaseVersion('7.1.0', [])).toBe('7.1.0');
  });
});

describe('commitMessages', () => {
  it('returns only the commits on HEAD, since the ref, that touch the package', () => {
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
        cwd,
        encoding: 'utf8',
      });
    const root = mkdtempSync(join(scratch, 'msgs-'));
    git(root, 'init', '-q', '-b', 'main');
    for (const f of ['packages/a/x.ts', 'packages/b/x.ts']) {
      mkdirSync(join(root, f, '..'), { recursive: true });
      writeFileSync(join(root, f), '1');
    }
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'feat(a)!: before the base');
    git(root, 'checkout', '-q', '-b', 'pr');
    writeFileSync(join(root, 'packages/a/x.ts'), '2');
    git(root, 'commit', '-qam', 'feat(a)!: breaking in a');
    writeFileSync(join(root, 'packages/b/x.ts'), '2');
    git(root, 'commit', '-qam', 'fix(b): small');
    expect(commitMessages(root, 'main', 'a')).toEqual(['feat(a)!: breaking in a']);
    expect(commitMessages(root, 'main', 'b')).toEqual(['fix(b): small']);
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

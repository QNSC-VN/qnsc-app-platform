import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * pg-boss is ESM-only and its own declarations fail to compile under this repo's
 * `moduleResolution` without `skipLibCheck` (ADR 0001 F11, decision 7). So no published
 * declaration may import it, and a product therefore never needs to. Checked on the BUILT
 * output, because that is what a consumer compiles.
 */
const root = join(__dirname, '..');
const dist = join(root, 'dist');

function declarations(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? declarations(path) : path.endsWith('.d.ts') ? [path] : [];
  });
}

describe('the published package', () => {
  it('has been built (run `pnpm build` first)', () => {
    expect(existsSync(join(dist, 'index.d.ts')), 'dist/ is missing: build before testing').toBe(
      true,
    );
  });

  it('no declaration imports or re-exports anything from pg-boss', () => {
    const offenders = declarations(dist).filter((file) =>
      /from\s+['"]pg-boss['"]|import\(\s*['"]pg-boss['"]\s*\)|require\(\s*['"]pg-boss['"]\s*\)/.test(
        readFileSync(file, 'utf8'),
      ),
    );
    expect(offenders, `pg-boss types leak through: ${offenders.join(', ')}`).toEqual([]);
  });

  it('exports the documented surface from the root, and nothing of pg-boss', async () => {
    const api = await import('./index');
    expect(Object.keys(api).sort()).toEqual(
      [
        'DEFAULTS',
        'DEFAULT_TIME_ZONE',
        'JobsConfigError',
        'OLDEST_READY_AGE_METRIC',
        'PermanentJobError',
        'createJobs',
        'createJobsPool',
        'currentCorrelationId',
        'idempotencyId',
        'installJobsSchema',
        'jobsGrantsSql',
        'roleFrom',
        'stopBudgetMs',
      ].sort(),
    );
  });

  it('pins pg-boss exactly, as a dependency and not a peer', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
      peerDependencies: Record<string, string>;
    };
    expect(pkg.dependencies['pg-boss']).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.peerDependencies).not.toHaveProperty('pg-boss');
  });

  it('ships the legacy-resolution shims for /nest and /testing', () => {
    for (const name of ['nest', 'testing']) {
      expect(existsSync(join(root, `${name}.js`))).toBe(true);
      expect(existsSync(join(root, `${name}.d.ts`))).toBe(true);
    }
  });
});

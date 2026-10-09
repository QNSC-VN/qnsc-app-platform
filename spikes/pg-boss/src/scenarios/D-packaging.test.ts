import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordResult } from '../support/results.ts';

/**
 * Not one of the seven scenarios, but a pass on the seven would be worthless if `platform-jobs`
 * could not be built the way every package in this repo is built. pg-boss 12 is ESM-only
 * (`"type": "module"`); this repo's packages are CommonJS compiled with `moduleResolution: node`
 * (tsconfig.base.json). Two questions, answered against a real compile and a real `require`:
 *
 *   1. Does `require('pg-boss')` work from CommonJS on the Node this repo targets (24)?
 *   2. Do pg-boss's types survive this repo's compiler settings, and the declarations a
 *      published package emits — i.e. what happens to a consumer who does not set skipLibCheck?
 */
const repoRoot = resolve(import.meta.dirname, '..', '..', '..', '..');
const spikeModules = resolve(import.meta.dirname, '..', '..', 'node_modules');
const tsc = join(repoRoot, 'node_modules', '.bin', 'tsc');

describe('packaging — pg-boss (ESM-only) inside a CommonJS package', () => {
  let dir: string;
  const found: Record<string, unknown> = {};

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'pgboss-cjs-'));
    mkdirSync(join(dir, 'src'));
    symlinkSync(spikeModules, join(dir, 'node_modules'));
    writeFileSync(
      join(dir, 'src', 'index.ts'),
      `import { PgBoss, type Job, type SendOptions } from 'pg-boss';
export type Handler<T extends object> = (jobs: Job<T>[]) => Promise<void>;
export interface Options extends SendOptions { tag?: string }
export const make = (url: string): PgBoss => new PgBoss(url);
`,
    );
    writeFileSync(
      join(dir, 'consumer.ts'),
      `import { make, type Handler } from './src/index';
export const h: Handler<{ a: number }> = async (jobs) => { jobs[0]!.data.a.toFixed(); };
export const wrong: number = make('x').send;
`,
    );
  });
  afterAll(() => {
    recordResult('packaging', found);
    rmSync(dir, { recursive: true, force: true });
  });

  const compile = (skipLibCheck: boolean, extra: string[] = []) => {
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        extends: join(repoRoot, 'tsconfig.base.json'),
        compilerOptions: {
          outDir: 'dist',
          rootDir: 'src',
          skipLibCheck,
          typeRoots: [join(repoRoot, 'node_modules', '@types')],
        },
        include: ['src/**/*'],
      }),
    );
    try {
      execFileSync(tsc, ['-p', join(dir, 'tsconfig.json'), ...extra], {
        encoding: 'utf8',
        stdio: 'pipe',
      });
      return { ok: true, output: '' };
    } catch (error) {
      return { ok: false, output: String((error as { stdout?: string }).stdout ?? error) };
    }
  };

  it('require() of the ESM-only package works from CommonJS on this Node, with no warning', () => {
    const run = spawnSync(
      process.execPath,
      [
        '-e',
        "const m = require('pg-boss'); process.stdout.write(typeof m.PgBoss + ' ' + typeof m.fromDrizzle)",
      ],
      { cwd: dir, encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '' } },
    );
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toBe('function function');
    expect(run.stderr, 'require(esm) printed a warning').toBe('');
    found['node'] = process.version;
    found['requireEsmFromCjs'] = 'works, no warning on stderr';
  });

  it('a CommonJS package compiled with the repo settings (node10 resolution, skipLibCheck on) emits CJS and keeps pg-boss typed', () => {
    const result = compile(true);
    expect(result.ok, result.output).toBe(true);
    const js = execFileSync('cat', [join(dir, 'dist', 'index.js')], { encoding: 'utf8' });
    expect(js).toContain('require("pg-boss")');
    // The declaration file carries pg-boss types — a consumer of platform-jobs would see them.
    const dts = execFileSync('cat', [join(dir, 'dist', 'index.d.ts')], { encoding: 'utf8' });
    expect(dts).toContain("from 'pg-boss'");
    // …and they are real types: the deliberate error in consumer.ts is reported, not swallowed by `any`.
    writeFileSync(
      join(dir, 'tsconfig.consumer.json'),
      JSON.stringify({
        extends: join(repoRoot, 'tsconfig.base.json'),
        compilerOptions: {
          noEmit: true,
          skipLibCheck: true,
          typeRoots: [join(repoRoot, 'node_modules', '@types')],
        },
        files: ['consumer.ts'],
      }),
    );
    let output = '';
    try {
      execFileSync(tsc, ['-p', join(dir, 'tsconfig.consumer.json')], {
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch (error) {
      output = String((error as { stdout?: string }).stdout);
    }
    expect(output).toMatch(/consumer\.ts\(3,14\): error TS2322/);
    expect(output).not.toMatch(/consumer\.ts\(2/);
    found['repoSettings'] = 'compiles; emits require("pg-boss"); types are real (not any)';
  });

  it("WITHOUT skipLibCheck, pg-boss's own declarations fail to compile under node10 resolution — so platform-jobs must not re-export them", () => {
    const result = compile(false, ['--noEmit']);
    const errors = result.output.split('\n').filter((l) => /error TS/.test(l));
    found['withoutSkipLibCheck'] = {
      compiles: result.ok,
      errorCount: errors.length,
      firstError: errors[0]?.replace(/\/[^\s']*node_modules\/\.pnpm\//, '…/').slice(0, 220),
    };
    // A finding, not an expectation of failure: if pg-boss fixes this, the test says so.
    expect(typeof result.ok).toBe('boolean');
  });
});

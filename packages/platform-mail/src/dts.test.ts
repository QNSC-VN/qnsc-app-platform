import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The declarations a consumer compiles, checked on the BUILT output (the CI test job builds first;
 * locally these skip without a build, on CI a missing build fails).
 *
 * `nodemailer` and `@azure/identity` are OPTIONAL peers: a product on the `graph` transport
 * installs neither `nodemailer` nor its types, and must still compile. So no published declaration
 * may import either — the transports declare what they need structurally. The same goes for
 * `pg-boss`, which a product never installs (platform-jobs ADR 0001, F11).
 */
const dist = join(import.meta.dirname, '..', 'dist');
const built = existsSync(join(dist, 'index.d.ts'));

function declarations(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? declarations(path) : path.endsWith('.d.ts') ? [path] : [];
  });
}

const importsOf = (file: string): string[] =>
  [
    ...readFileSync(file, 'utf8').matchAll(
      /(?:from\s+|import\s*\(\s*|require\(\s*|import\s+)['"]([^'"]+)['"]/g,
    ),
  ].map((match) => match[1]!);

describe('the published declarations', () => {
  it.runIf(Boolean(process.env['CI']))('are built when running on CI', () => {
    expect(built).toBe(true);
  });

  describe.skipIf(!built)('in dist/', () => {
    const files = built ? declarations(dist) : [];

    it('cover the whole package, smtp transport included', () => {
      const names = files.map((f) => f.slice(dist.length + 1));
      expect(names).toEqual(
        expect.arrayContaining([
          'index.d.ts',
          'smtp.d.ts',
          'factory.d.ts',
          'nest/index.d.ts',
          'testing/index.d.ts',
        ]),
      );
    });

    it.each([
      'nodemailer',
      '@types/nodemailer',
      '@azure/identity',
      'pg-boss',
      'ioredis',
      'mailparser',
    ])('no declaration imports %s', (forbidden) => {
      const offenders = files.filter((file) =>
        importsOf(file).some((spec) => spec === forbidden || spec.startsWith(`${forbidden}/`)),
      );
      expect(offenders, `${forbidden} leaks through: ${offenders.join(', ')}`).toEqual([]);
    });

    it('name no nodemailer type even without an import (a global or a triple-slash reference)', () => {
      const offenders = files.filter((file) => /nodemailer/i.test(readFileSync(file, 'utf8')));
      // Prose in a doc comment is fine; a type reference is not.
      for (const file of offenders) {
        const code = readFileSync(file, 'utf8')
          .split('\n')
          .filter((line) => !/^\s*(\/\*\*|\*|\/\/)/.test(line));
        expect(code.join('\n'), file).not.toMatch(/nodemailer/i);
      }
    });

    it('import only what a consumer has: node built-ins, relative files and the declared peers', () => {
      const allowed = new Set([
        '@nestjs/common',
        '@quynhonsemiconductor/observability',
        '@quynhonsemiconductor/platform-jobs',
        '@quynhonsemiconductor/platform-jobs/nest',
      ]);
      const specs = new Set(files.flatMap(importsOf));
      const foreign = [...specs].filter(
        (spec) => !spec.startsWith('.') && !spec.startsWith('node:') && !allowed.has(spec),
      );
      expect(foreign).toEqual([]);
    });
  });
});

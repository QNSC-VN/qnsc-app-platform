// Point a product checkout at tarballs built from THIS pull request.
//
//   node tools/consumer-ci/link.mjs --product <dir> --tarballs <dir>
//
// For every `package.json` in the product (skipping node_modules), a dependency on one of our
// packages becomes `file:<absolute tarball>` -- but ONLY when the tarball's version satisfies the
// range that product declares for it. A product on `^7.1.0` cannot meaningfully be tested against
// identity 8.0.0: it has not adopted it, and forcing it in would turn every major into a red
// gate that nobody can fix from here. Such a dependency is skipped, and says so:
//
//     not applicable: identity@8.0.0 outside ^7.1.0
//
// `peerDependencies` are left alone: they are the range a product accepts, and that is exactly
// what must keep being tested.
//
// Outcomes:
//   * something linked                      -> exit 0, `applicable=true`
//   * every dependency was out of range     -> exit 0, `applicable=false` (the product has no
//                                              business being tested against this PR; the
//                                              workflow skips install and tests)
//   * the product depends on NONE of ours   -> exit 1. That is a different problem: a check that
//                                              quietly tests the registry versions would be
//                                              green and prove nothing.
//
// A range `semver` cannot parse (`latest`, a git URL) is linked: there is no range to be outside of.
import { appendFileSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import semver from 'semver';
import { findManifests, rel } from './packages.mjs';

const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];

/**
 * Rewrite one manifest object in place.
 * `tarballs` maps package name -> { file, version }.
 * Returns `{ linked: string[], skipped: { name, version, range }[] }`.
 */
export function linkManifest(json, tarballs) {
  const linked = [];
  const skipped = [];
  for (const section of SECTIONS) {
    const deps = json[section];
    if (!deps) continue;
    for (const name of Object.keys(deps)) {
      const tarball = tarballs.get(name);
      if (!tarball) continue;
      const range = deps[name];
      if (semver.validRange(range) !== null && !semver.satisfies(tarball.version, range)) {
        skipped.push({ name, version: tarball.version, range });
        continue;
      }
      deps[name] = `file:${tarball.file}`;
      linked.push(name);
    }
  }
  return { linked, skipped };
}

function option(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function main() {
  const product = resolve(option('product') ?? '');
  const dir = resolve(option('tarballs') ?? '');
  if (!option('product') || !option('tarballs')) {
    process.stderr.write('usage: link.mjs --product <dir> --tarballs <dir>\n');
    process.exit(2);
  }
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const tarballs = new Map(
    manifest.map((m) => [m.name, { file: join(dir, m.file), version: m.version }]),
  );

  let linkedCount = 0;
  let skippedCount = 0;
  for (const file of findManifests(product)) {
    const json = JSON.parse(readFileSync(file, 'utf8'));
    const { linked, skipped } = linkManifest(json, tarballs);
    if (linked.length > 0) {
      writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
      process.stdout.write(`${rel(product, file)}: linked ${linked.join(', ')}\n`);
    }
    for (const { name, version, range } of skipped) {
      process.stdout.write(
        `not applicable: ${shortName(name)}@${version} outside ${range} (${rel(product, file)})\n`,
      );
    }
    linkedCount += linked.length;
    skippedCount += skipped.length;
  }

  if (linkedCount === 0 && skippedCount === 0) {
    process.stderr.write(
      `No dependency on ${[...tarballs.keys()].join(', ')} found in ${product}.\n`,
    );
    process.exit(1);
  }

  const applicable = linkedCount > 0;
  if (!applicable) {
    process.stdout.write(
      'Nothing in this pull request applies to this product: every package it uses is outside the range the product declares.\n',
    );
  }
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `applicable=${applicable}\n`);
}

/** `@quynhonsemiconductor/identity` -> `identity`, as it reads in the log. */
function shortName(name) {
  return name.replace(/^@[^/]+\//, '');
}

// Run only as a script, not when the test file imports `linkManifest`. Compare REAL paths: a
// symlinked directory (macOS /tmp -> /private/tmp) made the plain `file://` comparison false,
// so `main` silently never ran and the command exited 0 having linked nothing.
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
)
  main();

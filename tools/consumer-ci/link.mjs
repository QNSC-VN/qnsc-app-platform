// Point a product checkout at tarballs built from THIS pull request.
//
//   node tools/consumer-ci/link.mjs --product <dir> --tarballs <dir>
//
// For every `package.json` in the product (skipping node_modules), a dependency on one of our
// packages becomes `file:<absolute tarball>`. `peerDependencies` are left alone: they are the
// range a product accepts, and that is exactly what must keep being tested.
//
// Fails when nothing was linked. A consumer check that quietly tests the registry versions
// instead of this pull request's would be green and prove nothing.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { findManifests, rel } from './packages.mjs';

const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];

/** Rewrite one manifest object in place; returns the dependency names it changed. */
export function linkManifest(json, tarballs) {
  const changed = [];
  for (const section of SECTIONS) {
    const deps = json[section];
    if (!deps) continue;
    for (const name of Object.keys(deps)) {
      const tarball = tarballs.get(name);
      if (tarball) {
        deps[name] = `file:${tarball}`;
        changed.push(name);
      }
    }
  }
  return changed;
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
  const tarballs = new Map(manifest.map((m) => [m.name, join(dir, m.file)]));

  let total = 0;
  for (const file of findManifests(product)) {
    const json = JSON.parse(readFileSync(file, 'utf8'));
    const changed = linkManifest(json, tarballs);
    if (changed.length === 0) continue;
    writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
    total += changed.length;
    process.stdout.write(`${rel(product, file)}: ${changed.join(', ')}\n`);
  }
  if (total === 0) {
    process.stderr.write(
      `No dependency on ${[...tarballs.keys()].join(', ')} found in ${product}.\n`,
    );
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();

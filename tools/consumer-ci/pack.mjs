// Pack the publishable workspace packages into tarballs.
//
//   node tools/consumer-ci/pack.mjs --out <dir>
//   node tools/consumer-ci/pack.mjs --out <dir> --canary pr.12.abc1234 --changed-since origin/main
//   ... --bump-since origin/main --pr-title "$PR_TITLE"   (breaking marker may live only in the title)
//
// Writes `<out>/manifest.json`: [{ name, dir, version, file }]. `version` is the version INSIDE the
// tarball, so a canary build reports `7.1.0-pr.12.abc1234`, not `7.1.0`.
//
// Without --canary the tarballs carry the real versions. That is what consumer CI wants: a
// prerelease version would not satisfy a peer range such as `>=2.0.0`, so the product would no
// longer resolve the very packages it is being checked against.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { changedPackageDirs, listPackages, packageMessages, releaseVersion } from './packages.mjs';

function option(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const root = process.cwd();
const out = resolve(option('out') ?? 'tarballs');
const canary = option('canary');
const since = option('changed-since');
// Version-bump base. A PR's package.json still carries the RELEASED version, so a breaking PR has to
// be given the version it will get, or products on the old major would wrongly be tested against it.
const bumpSince = option('bump-since') ?? since;
// The PR title counts as one more commit message (a squash merge commits it), so `feat!:` in the
// title alone is enough.
const prTitle = option('pr-title');

if (canary !== undefined && !/^pr\.\d+\.[0-9a-f]{7}$/.test(canary)) {
  process.stderr.write(`--canary must look like pr.<number>.<sha7>, got "${canary}"\n`);
  process.exit(2);
}

const all = listPackages(root);
const dirs = since ? new Set(changedPackageDirs(root, since, all)) : new Set(all.map((p) => p.dir));
const selected = all.filter((p) => dirs.has(p.dir));

mkdirSync(out, { recursive: true });
const manifest = [];

for (const pkg of selected) {
  const cwd = join(root, 'packages', pkg.dir);
  const file = join(cwd, 'package.json');
  const original = readFileSync(file, 'utf8');
  let version = bumpSince
    ? releaseVersion(pkg.version, packageMessages(root, bumpSince, pkg.dir, prTitle))
    : pkg.version;
  const rewritten = version !== pkg.version || canary !== undefined;
  try {
    if (canary) version = `${version}-${canary}`;
    if (rewritten) {
      const json = JSON.parse(original);
      json.version = version;
      writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
    }
    // `pnpm pack` rewrites `workspace:` ranges to real versions and honours `files`.
    const stdout = execFileSync('pnpm', ['pack', '--pack-destination', out], {
      cwd,
      encoding: 'utf8',
    });
    const tarball = stdout.trim().split('\n').pop();
    manifest.push({ name: pkg.name, dir: pkg.dir, version, file: tarball.split('/').pop() });
  } finally {
    // Never leave the rewritten version behind in the working tree.
    if (rewritten) writeFileSync(file, original);
  }
}

writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(
  manifest.length
    ? manifest.map((m) => `${m.name}@${m.version}  ${m.file}`).join('\n') + '\n'
    : 'No publishable package changed; nothing packed.\n',
);

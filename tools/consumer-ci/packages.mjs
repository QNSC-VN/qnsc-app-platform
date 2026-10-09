// Shared helpers for the canary and consumer-CI workflows.
//
// Plain ESM with no dependencies on purpose: these run in CI before (and independently of) any
// build, and `node` executes them directly.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import semver from 'semver';

/** Every publishable package under `<root>/packages`: `{ dir, name, version }`. */
export function listPackages(root) {
  const base = join(root, 'packages');
  return readdirSync(base)
    .map((dir) => ({ dir, file: join(base, dir, 'package.json') }))
    .filter(({ file }) => existsSync(file))
    .map(({ dir, file }) => ({ dir, manifest: JSON.parse(readFileSync(file, 'utf8')) }))
    .filter(({ manifest }) => manifest.private !== true)
    .map(({ dir, manifest }) => ({ dir, name: manifest.name, version: manifest.version }));
}

/**
 * Package directories that differ from `ref`. A change to a file every package is built from
 * (the shared tsconfig, the toolchain pins, the lockfile) counts as changing all of them.
 */
export function changedPackageDirs(root, ref, all) {
  const out = execFileSync('git', ['diff', '--name-only', `${ref}...HEAD`], {
    cwd: root,
    encoding: 'utf8',
  });
  const files = out.split('\n').filter(Boolean);
  const shared = new Set([
    'tsconfig.base.json',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
  ]);
  if (files.some((f) => shared.has(f))) return all.map((p) => p.dir);
  const dirs = new Set();
  for (const f of files) {
    const m = /^packages\/([^/]+)\//.exec(f);
    if (m) dirs.add(m[1]);
  }
  return all.map((p) => p.dir).filter((d) => dirs.has(d));
}

/** Every `package.json` below `root`, skipping dependency and VCS directories. */
export function findManifests(root) {
  const skip = new Set(['node_modules', '.git', 'dist', 'coverage']);
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (skip.has(entry)) continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry === 'package.json') found.push(path);
    }
  };
  walk(root);
  return found;
}

/** Posix-style relative path, for stable log output. */
export function rel(root, path) {
  return relative(root, path).split(sep).join('/');
}

/**
 * Is this commit message a breaking change by Conventional Commits? `type!:` / `type(scope)!:` in the
 * subject, or a `BREAKING CHANGE:` / `BREAKING-CHANGE:` footer.
 */
export function isBreaking(message) {
  const subject = message.split('\n', 1)[0] ?? '';
  return /^\w+(\([^)]*\))?!:/.test(subject) || /^BREAKING[ -]CHANGE:/m.test(message);
}

/**
 * The version release-please would give a package on merge, as far as RANGES are concerned.
 *
 * A pull request does not change `version` in package.json -- release-please does that after the
 * merge -- so a `feat!:` PR against identity 7.1.0 would otherwise be packed as 7.1.0, look
 * "in range" for every product on ^7.1.0, and break them all. Only a breaking change can leave a
 * caret range, so only that is modelled: a major bump, or a minor bump below 1.0.0 (this repo sets
 * `bump-minor-pre-major`). Anything else keeps the current version.
 */
export function releaseVersion(current, messages) {
  if (!messages.some(isBreaking)) return current;
  return semver.inc(current, semver.major(current) === 0 ? 'minor' : 'major');
}

/** Commit messages on HEAD but not on `ref` that touch `packages/<dir>`. */
export function commitMessages(root, ref, dir) {
  const out = execFileSync(
    'git',
    ['log', '--no-merges', '--format=%B%x00', `${ref}..HEAD`, '--', `packages/${dir}`],
    { cwd: root, encoding: 'utf8' },
  );
  return out
    .split('\0')
    .map((m) => m.trim())
    .filter(Boolean);
}

/** Whether `tag` exists in the repository. */
export function tagExists(root, tag) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`], {
      cwd: root,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Every message that decides a package's next version: its commits since the LAST RELEASE, plus the
 * PR title.
 *
 * "Since the last release" is the tag `<component>-v<version>` that release-please cut, because that
 * is what release-please itself counts. The PR's own base is the wrong baseline: a breaking change
 * that is already on main but not yet released (identity 8, say) is invisible to every later PR, so
 * that PR packed the new major's code as the old version, linked it into products still on the old
 * range, and failed all of them. When the tag does not exist (a package's first release, or the
 * release PR itself, whose package.json already carries the new version) the PR's base is used.
 *
 * A squash merge commits the PR TITLE, so a `feat!:` title is breaking even when no commit says so.
 * The title speaks for what the PR changes, so it is added only for a package the PR has commits in.
 */
export function packageMessages(root, ref, dir, prTitle, tag) {
  const since = tag && tagExists(root, tag) ? tag : ref;
  const messages = commitMessages(root, since, dir);
  if (prTitle && commitMessages(root, ref, dir).length > 0) messages.push(prTitle);
  return messages;
}

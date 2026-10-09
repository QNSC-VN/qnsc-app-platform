/**
 * Load `.env` into `process.env` BEFORE anything else runs. Import this first, above the
 * OTel bootstrap, in every entrypoint.
 *
 * WHY IT HAS TO BE THIS EARLY
 * ---------------------------
 * `@nestjs/config` reads `.env`, but only when ConfigModule initialises — which is after
 * `import './otel'`. The OTel bootstrap has to run first so auto-instrumentation can patch
 * http, pg and ioredis before those modules load, and it reads `process.env` directly.
 *
 * The result was a flag that read as configuration and could not take effect: with
 * `OTEL_ENABLED=true` in `.env`, `startOtel()` saw it unset and did nothing at all. Proven
 * by contrast against a live collector — `.env` alone produced zero exported series, the
 * same value exported in the shell produced 219. Deployed environments never noticed
 * because a container platform (Kubernetes) injects real environment variables rather than a
 * file.
 *
 * A LEAF MODULE ON PURPOSE: it imports nothing but `node:process`. Reaching it through the
 * `@quynhonsemiconductor/platform-runtime/load-env` subpath rather than the package root is what
 * keeps that true — the barrel pulls in Nest, drizzle and ioredis, and requiring those here would load
 * the very modules OTel still needs to patch. Same reason the OTel bootstrap itself is
 * imported from `@quynhonsemiconductor/observability/otel` and not the package root.
 *
 * `loadEnvFile` does NOT overwrite variables that are already set, verified on Node 24, so
 * a real environment always wins over the file. That is what makes this safe to run in
 * every environment rather than only locally.
 */
import process from 'node:process';

try {
  process.loadEnvFile();
} catch {
  // No `.env` — the normal case in CI and in a deployed container, where the environment is
  // injected directly. Nothing to do, and nothing worth logging: a logger here would be
  // another import competing with the instrumentation this file exists to unblock.
}

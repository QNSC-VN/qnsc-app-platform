import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Measured numbers go to `results/<scenario>.json`, committed with the spike, so the ADR cites
 * files a reviewer can open instead of a log that scrolled away. Each key is written once per
 * run; running a scenario again overwrites its own key only.
 */
const dir = join(import.meta.dirname, '..', '..', 'results');

export function recordResult(scenario: string, values: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${scenario}.json`);
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    // first write
  }
  writeFileSync(
    file,
    JSON.stringify({ ...existing, ...values, recordedAt: new Date().toISOString() }, null, 2) +
      '\n',
  );
}

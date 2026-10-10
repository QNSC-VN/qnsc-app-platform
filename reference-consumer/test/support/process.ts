import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

export interface LogLine {
  [key: string]: unknown;
  msg?: string;
  correlationId?: string;
}

/**
 * A real OS process running the compiled entry (`dist/api.js` or `dist/worker.js`), so a SIGTERM is a
 * SIGTERM and the shutdown path is the one a pod takes. Its stdout is parsed as JSON lines (the
 * contract's log format); anything that is not JSON is kept as raw text.
 */
export class Proc {
  readonly lines: LogLine[] = [];
  readonly raw: string[] = [];
  readonly stderr: string[] = [];
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly child: ChildProcess;
  private buffer = '';

  constructor(
    readonly name: string,
    entry: 'api' | 'worker',
    env: Record<string, string>,
  ) {
    this.child = spawn(process.execPath, [join(__dirname, '..', '..', 'dist', `${entry}.js`)], {
      env: { PATH: process.env['PATH'] ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child.stdout?.on('data', (chunk: Buffer) => this.onStdout(chunk));
    this.child.stderr?.on('data', (chunk: Buffer) => this.stderr.push(chunk.toString()));
    this.exited = new Promise((resolve) =>
      this.child.once('exit', (code, signal) => resolve({ code, signal })),
    );
  }

  private onStdout(chunk: Buffer): void {
    this.buffer += chunk.toString();
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const text = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf('\n');
      if (!text.trim()) continue;
      this.raw.push(text);
      try {
        this.lines.push(JSON.parse(text) as LogLine);
      } catch {
        /* not JSON: kept in `raw` only */
      }
    }
  }

  get alive(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  signal(sig: NodeJS.Signals): void {
    this.child.kill(sig);
  }

  /** Lines whose `msg` matches, optionally restricted to one correlation id. */
  find(msg: string | RegExp, correlationId?: string): LogLine[] {
    return this.lines.filter(
      (l) =>
        (typeof msg === 'string' ? l.msg === msg : msg.test(String(l.msg ?? ''))) &&
        (correlationId === undefined || l.correlationId === correlationId),
    );
  }

  /** Resolves with the first matching line (already seen or yet to come). */
  async waitFor(msg: string | RegExp, timeoutMs = 60_000, correlationId?: string): Promise<LogLine> {
    try {
      return await eventually(
        () => {
          const [line] = this.find(msg, correlationId);
          if (!line) throw new Error(`${this.name}: no log line ${String(msg)} yet`);
          if (!this.alive && this.child.exitCode !== 0) {
            throw new Error(`${this.name} exited with ${String(this.child.exitCode)}`);
          }
          return line;
        },
        { timeoutMs, what: `${this.name} log ${String(msg)}` },
      );
    } catch (error) {
      // A process that never logs what we wait for is best explained by what it did log.
      throw new Error(
        `${String(error)}\n--- ${this.name} stdout (last 15) ---\n${this.raw.slice(-15).join('\n')}` +
          `\n--- ${this.name} stderr ---\n${this.stderr.join('').slice(-2000)}` +
          `\n--- ${this.name} alive=${String(this.alive)} exit=${String(this.child.exitCode)}`,
      );
    }
  }

  async stop(): Promise<void> {
    if (this.alive) this.signal('SIGKILL');
    await this.exited;
  }
}

export async function eventually<T>(
  fn: () => T | Promise<T>,
  { timeoutMs = 30_000, intervalMs = 150, what = 'condition' } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}: ${String(last)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

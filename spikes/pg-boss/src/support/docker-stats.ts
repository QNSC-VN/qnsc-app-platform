import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** The container publishing `hostPort`: the testcontainers harness does not expose its id. */
export async function containerIdByPort(hostPort: number): Promise<string> {
  const { stdout } = await run('docker', [
    'ps',
    '--filter',
    `publish=${hostPort}`,
    '--format',
    '{{.ID}}',
  ]);
  const id = stdout.trim().split('\n')[0];
  if (!id) throw new Error(`no container publishes port ${hostPort}`);
  return id;
}

/** `docker update --cpus`: a CNPG pod has a CPU limit, a bare container does not. */
export async function limitCpus(containerId: string, cpus: number): Promise<void> {
  await run('docker', [
    'update',
    '--cpus',
    String(cpus),
    '--memory',
    '2g',
    '--memory-swap',
    '2g',
    containerId,
  ]);
}

export interface CpuSample {
  /** Percent of ONE core (docker's convention): 100 = one core fully busy. */
  cpuPercent: number;
  memBytes: number;
}

const UNIT: Record<string, number> = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 };

export async function cpuSample(containerId: string): Promise<CpuSample> {
  const { stdout } = await run('docker', [
    'stats',
    '--no-stream',
    '--format',
    '{{.CPUPerc}}|{{.MemUsage}}',
    containerId,
  ]);
  const [cpu, mem] = stdout.trim().split('|') as [string, string];
  const [used] = mem.split('/').map((x) => x.trim()) as [string, string];
  const m = /^([\d.]+)\s*([KMG]?i?B)$/.exec(used)!;
  return {
    cpuPercent: Number.parseFloat(cpu),
    memBytes: Number.parseFloat(m[1]!) * (UNIT[m[2]!] ?? 1),
  };
}

/**
 * Cumulative CPU time of a local process in seconds (`ps -o time=`: `[H:]MM:SS.hh`). Two readings
 * a known wall time apart give its CPU use over that interval; `ps -o %cpu` is a lifetime average
 * on macOS and would flatter a process that has been idle for most of its life.
 */
export async function processCpuSeconds(pid: number): Promise<number> {
  const { stdout } = await run('ps', ['-o', 'time=', '-p', String(pid)]);
  const parts = stdout.trim().split(':').map(Number.parseFloat);
  return parts.reduce((total, part) => total * 60 + part, 0);
}

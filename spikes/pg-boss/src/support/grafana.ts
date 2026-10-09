import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

const run = promisify(execFile);

export const GRAFANA_IMAGE = 'grafana/grafana-oss:13.0.2';

export interface Grafana {
  readonly url: string;
  /** `fetch` against the Grafana HTTP API with the admin credentials generated for this run. */
  api<T = unknown>(path: string, init?: { method?: string; body?: unknown }): Promise<T>;
  stop(): Promise<void>;
}

/**
 * A throwaway Grafana for the dashboard scenario. The admin password is generated per run and
 * never leaves the process; anonymous access and sign-up are off, telemetry and update checks are
 * off, and nothing is mounted from the host.
 */
export async function startGrafana(): Promise<Grafana> {
  const password = randomBytes(18).toString('hex');
  const container: StartedTestContainer = await new GenericContainer(GRAFANA_IMAGE)
    .withEnvironment({
      GF_SECURITY_ADMIN_USER: 'admin',
      GF_SECURITY_ADMIN_PASSWORD: password,
      GF_USERS_ALLOW_SIGN_UP: 'false',
      GF_AUTH_ANONYMOUS_ENABLED: 'false',
      GF_ANALYTICS_REPORTING_ENABLED: 'false',
      GF_ANALYTICS_CHECK_FOR_UPDATES: 'false',
      GF_PLUGINS_PREINSTALL_DISABLED: 'true',
    })
    .withExposedPorts(3000)
    .withWaitStrategy(Wait.forHttp('/api/health', 3000).forStatusCode(200))
    .withStartupTimeout(180_000)
    .start();
  const url = `http://${container.getHost()}:${container.getMappedPort(3000)}`;
  const auth = `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`;
  return {
    url,
    async api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
      const response = await fetch(`${url}${path}`, {
        method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
        headers: { authorization: auth, 'content-type': 'application/json' },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
      const text = await response.text();
      if (!response.ok)
        throw new Error(`Grafana ${path} → ${response.status}: ${text.slice(0, 500)}`);
      return (text ? JSON.parse(text) : undefined) as T;
    },
    stop: async () => void (await container.stop()),
  };
}

/**
 * The address of a container on the default bridge network, for container → container traffic
 * (Docker Desktop does not route the host to container IPs, but containers reach each other).
 */
export async function containerIp(hostPort: number): Promise<string> {
  const { stdout: id } = await run('docker', [
    'ps',
    '--filter',
    `publish=${hostPort}`,
    '--format',
    '{{.ID}}',
  ]);
  const { stdout } = await run('docker', [
    'inspect',
    '-f',
    '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}',
    id.trim().split('\n')[0]!,
  ]);
  return stdout.trim().split(' ')[0]!;
}

interface DsQueryResponse {
  results: Record<
    string,
    {
      status?: number;
      error?: string;
      frames?: {
        schema: { name?: string; fields: { name: string; labels?: Record<string, string> }[] };
        data: { values: unknown[][] };
      }[];
    }
  >;
}

export interface Series {
  name: string;
  /** column name → values; for a `time_series` frame the columns are `time` and `value`. */
  columns: Record<string, unknown[]>;
}

/** Run one panel query through `/api/ds/query` — the call the dashboard's own frontend makes. */
export async function runPanelQuery(
  grafana: Grafana,
  target: {
    refId: string;
    rawSql: string;
    format: string;
    datasource: { type: string; uid: string };
  },
  range: { from: string; to: string } = { from: 'now-30m', to: 'now' },
): Promise<Series[]> {
  const response = await grafana.api<DsQueryResponse>('/api/ds/query', {
    body: {
      ...range,
      queries: [{ ...target, intervalMs: 15_000, maxDataPoints: 1000 }],
    },
  });
  const result = response.results[target.refId]!;
  if (result.error) throw new Error(`panel query failed: ${result.error}`);
  return (result.frames ?? []).flatMap((frame): Series[] => {
    const names = frame.schema.fields.map((f) => f.name);
    const columns: Record<string, unknown[]> = {};
    names.forEach((name, i) => (columns[name] = frame.data.values[i]!));
    if (target.format !== 'time_series') return [{ name: frame.schema.name ?? '', columns }];
    // Grafana returns a time series with a `metric` column as ONE wide frame: `Time`, then one
    // value column per distinct metric. Split it back into one series per metric.
    const time = columns['Time'] ?? columns['time'] ?? [];
    return names
      .filter((name) => name !== 'Time' && name !== 'time')
      .map((name) => ({ name, columns: { time, value: columns[name]! } }));
  });
}

export const lastValue = (series: Series | undefined): number | undefined => {
  const values = series?.columns['value'];
  return values && values.length > 0 ? Number(values[values.length - 1]) : undefined;
};

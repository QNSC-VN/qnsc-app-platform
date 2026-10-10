import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { installJobsSchema } from '@quynhonsemiconductor/platform-jobs';
import { Pool } from 'pg';
import { REFERENCE_DDL } from '../../src/schema-ddl';
import { startMailpit, startPostgres, startValkey, type MailpitMessage } from './containers';
import { eventually, Proc } from './process';
import { SmtpProxy } from './smtp-proxy';

export const APP_ROLE = 'm6_app';

/** Injects a COMMIT-time failure for sign-ups whose address starts with `rollback-` (see setup). */
const FAULT_INJECTION = `
CREATE FUNCTION identity.fail_at_commit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.email LIKE 'rollback-%' THEN
    RAISE EXCEPTION 'injected failure at COMMIT';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER user_fail_at_commit AFTER INSERT ON identity."user"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity.fail_at_commit();`;

async function smtpBanner(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(3_000, () => fail(new Error('no SMTP banner')));
    socket.once('error', fail);
    socket.once('data', (data) => {
      socket.destroy();
      if (data.toString().startsWith('220')) resolve();
      else reject(new Error(`unexpected SMTP greeting: ${data.toString().slice(0, 40)}`));
    });
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

export class Stack {
  /** The migration role's pool: for assertions the application role must not be able to make. */
  admin!: Pool;
  postgres!: Awaited<ReturnType<typeof startPostgres>>;
  valkey!: Awaited<ReturnType<typeof startValkey>>;
  mailpit!: Awaited<ReturnType<typeof startMailpit>>;
  proxy!: SmtpProxy;
  apiPort!: number;
  api!: Proc;
  private appPassword = randomBytes(18).toString('hex');
  private authSecret = randomBytes(32).toString('hex');
  private readonly procs = new Set<Proc>();
  private ipCounter = 1;

  async start(): Promise<void> {
    [this.postgres, this.valkey, this.mailpit] = await Promise.all([
      startPostgres(),
      startValkey(),
      startMailpit(),
    ]);
    // The sink's SMTP port must be answering on the HOST side before anything sends to it: a container
    // reports ready before Docker's port mapping always accepts a connection (seen once, as one failed
    // first send in the first run). Read the 220 banner.
    await eventually(() => smtpBanner(this.mailpit.smtpPort), { timeoutMs: 20_000, what: 'SMTP banner' });
    this.proxy = new SmtpProxy({ host: this.mailpit.host, port: this.mailpit.smtpPort });
    await this.proxy.listen();

    this.admin = new Pool({
      host: this.postgres.host,
      port: this.postgres.port,
      user: 'migrator',
      password: this.postgres.password,
      database: this.postgres.database,
      max: 4,
    });
    await this.migrate();

    this.apiPort = await freePort();
    this.api = this.spawn('api', 'api', { PORT: String(this.apiPort) });
    await this.api.waitFor("api ready", 40_000);
  }

  /**
   * What a deployment does before the pods start: the product's own migrations, then the platform's
   * (`installJobsSchema` as the migrator role, granting the application role what it needs and no more).
   */
  private async migrate(): Promise<void> {
    await this.admin.query(
      `CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${this.appPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE`,
    );
    for (const statement of REFERENCE_DDL.split('--> statement-breakpoint')) {
      if (statement.trim()) await this.admin.query(statement);
    }
    await this.admin.query(
      `GRANT USAGE ON SCHEMA identity TO ${APP_ROLE};
       GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA identity TO ${APP_ROLE};`,
    );
    await this.admin.query(FAULT_INJECTION);
    await installJobsSchema(this.admin, { appRole: APP_ROLE });
  }

  env(extra: Record<string, string> = {}): Record<string, string> {
    return {
      NODE_ENV: 'development',
      DATABASE_HOST: this.postgres.host,
      DATABASE_PORT: String(this.postgres.port),
      DATABASE_NAME: this.postgres.database,
      DATABASE_USER: APP_ROLE,
      DATABASE_PASSWORD: this.appPassword,
      DATABASE_SSL: 'disable',
      REDIS_URL: this.valkey.url,
      MAIL_TRANSPORT: 'smtp',
      MAIL_SMTP_HOST: '127.0.0.1',
      MAIL_SMTP_PORT: String(this.mailpit.smtpPort),
      BETTER_AUTH_SECRET: this.authSecret,
      SHUTDOWN_ENDPOINT_DELAY_MS: '0',
      ...extra,
    };
  }

  spawn(name: string, entry: 'api' | 'worker', extra: Record<string, string> = {}): Proc {
    const proc = new Proc(name, entry, this.env(extra));
    this.procs.add(proc);
    return proc;
  }

  /** A worker process (`ROLE=worker`). `smtpPort` defaults to the sink itself; pass the proxy's to slow it. */
  async worker(
    name: string,
    extra: Record<string, string> = {},
  ): Promise<Proc> {
    const proc = this.spawn(name, 'worker', { ROLE: 'worker', ...extra });
    await proc.waitFor('worker ready', 90_000);
    return proc;
  }

  get apiUrl(): string {
    return `http://127.0.0.1:${this.apiPort}`;
  }

  /** A new address per call, so no request trips another's per-IP rate limit. */
  private nextIp(): string {
    const n = this.ipCounter++;
    return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
  }

  async signUp(email: string, correlationId?: string): Promise<Response> {
    return fetch(`${this.apiUrl}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: this.apiUrl,
        'cf-connecting-ip': this.nextIp(),
        ...(correlationId ? { 'x-correlation-id': correlationId } : {}),
      },
      body: JSON.stringify({ email, password: 'correct-horse-battery-staple', name: 'M6 User' }),
    });
  }

  async notify(
    body: { to: string; key: string; copies?: number; rollback?: boolean },
    correlationId?: string,
  ): Promise<Response> {
    return fetch(`${this.apiUrl}/v1/notify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-connecting-ip': this.nextIp(),
        ...(correlationId ? { 'x-correlation-id': correlationId } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  /** Wait until `n` messages to `address` are in the sink, and return them. */
  async mailTo(address: string, n: number, timeoutMs = 45_000): Promise<MailpitMessage[]> {
    return eventually(
      async () => {
        const found = await this.mailpit.messagesTo(address);
        if (found.length < n) throw new Error(`${found.length}/${n} messages to ${address}`);
        return found;
      },
      { timeoutMs, what: `${n} message(s) to ${address}` },
    );
  }

  async jobsFor(address: string): Promise<{ id: string; state: string; data: Record<string, unknown> }[]> {
    const { rows } = await this.admin.query(
      `SELECT id, state, data FROM pgboss.job WHERE name = 'mail.send' AND data->>'to' = $1`,
      [address],
    );
    return rows as never;
  }

  async stop(): Promise<void> {
    await Promise.allSettled([...this.procs].map((p) => p.stop()));
    await Promise.allSettled([this.admin?.end(), this.proxy?.close()]);
    await Promise.allSettled([this.postgres?.stop(), this.valkey?.stop(), this.mailpit?.stop()]);
  }
}

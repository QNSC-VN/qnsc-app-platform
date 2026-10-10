import { MailConfigError } from './errors';

/** What the environment can say. `process.env` in production; a plain object in tests. */
export type MailEnv = Readonly<Record<string, string | undefined>>;

export type MailTransportName = 'graph' | 'smtp';

export interface GraphConfig {
  transport: 'graph';
  /** The product's shared mailbox, e.g. `noreply-academy@qnsc.vn`. */
  sender: string;
  tenantId: string;
  clientId: string;
  credential:
    | { kind: 'workload-identity'; tokenFilePath: string }
    | { kind: 'client-secret'; clientSecret: string };
}

export interface SmtpConfig {
  transport: 'smtp';
  host: string;
  port: number;
  /** Envelope and header sender. */
  from: string;
}

export type MailConfig = GraphConfig | SmtpConfig;

const ADDRESS = /^[^\s@<>()[\],;:"\\]+@[^\s@<>()[\],;:"\\]+\.[^\s@<>()[\],;:"\\]+$/;

// eslint-disable-next-line no-control-regex -- the point is to reject control characters
const CONTROL = /[\u0000-\u001f\u007f]/;

function value(env: MailEnv, name: string): string | undefined {
  const trimmed = env[name]?.trim();
  if (trimmed === undefined || trimmed === '') return undefined;
  // After trimming: a stray trailing newline from a mounted file is harmless, but a control
  // character INSIDE the value would end up in a URL, a header or an SMTP command.
  if (CONTROL.test(trimmed)) throw new MailConfigError(`${name} contains a control character.`);
  return trimmed;
}

function required(env: MailEnv, name: string, why: string): string {
  const found = value(env, name);
  if (found === undefined) throw new MailConfigError(`${name} is required ${why}.`);
  return found;
}

/** `true` when this process is production. Spelled one way, here, so every check agrees. */
export function isProduction(env: MailEnv): boolean {
  return env['NODE_ENV'] === 'production';
}

/**
 * Read the mail configuration from the environment. Every error names the variable and says
 * what to do; nothing is read from anywhere else, and nothing has a product-specific default.
 *
 * | variable                 | for      | notes                                                          |
 * | ------------------------ | -------- | -------------------------------------------------------------- |
 * | `MAIL_TRANSPORT`         | all      | `graph` or `smtp`. Required — there is no silent default       |
 * | `MAIL_GRAPH_SENDER`      | graph    | the product's shared mailbox                                   |
 * | `AZURE_TENANT_ID`        | graph    | Entra tenant                                                   |
 * | `AZURE_CLIENT_ID`        | graph    | the product's own Entra app                                    |
 * | `AZURE_FEDERATED_TOKEN_FILE` | graph | projected ServiceAccount token (workload identity). Preferred |
 * | `AZURE_CLIENT_SECRET`    | graph    | local testing only; refused when `NODE_ENV=production`         |
 * | `MAIL_SMTP_HOST`/`_PORT`/`_FROM` | smtp | Mailpit defaults; refused when `NODE_ENV=production`     |
 */
export function readMailConfig(env: MailEnv = process.env): MailConfig {
  const transport = value(env, 'MAIL_TRANSPORT');
  if (transport === undefined) {
    throw new MailConfigError(
      'MAIL_TRANSPORT is required: set it to "graph" (or "smtp" outside production).',
    );
  }

  if (transport === 'smtp') {
    if (isProduction(env)) {
      throw new MailConfigError(
        'MAIL_TRANSPORT=smtp is refused when NODE_ENV=production. Use MAIL_TRANSPORT=graph.',
      );
    }
    const port = Number(value(env, 'MAIL_SMTP_PORT') ?? '1025');
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new MailConfigError('MAIL_SMTP_PORT must be a port number between 1 and 65535.');
    }
    const from = value(env, 'MAIL_SMTP_FROM') ?? 'noreply@localhost.test';
    if (!ADDRESS.test(from))
      throw new MailConfigError('MAIL_SMTP_FROM must be a plain email address.');
    return { transport: 'smtp', host: value(env, 'MAIL_SMTP_HOST') ?? 'localhost', port, from };
  }

  if (transport !== 'graph') {
    throw new MailConfigError(
      `MAIL_TRANSPORT=${JSON.stringify(transport)} is not supported; use "graph" or "smtp".`,
    );
  }

  const sender = required(
    env,
    'MAIL_GRAPH_SENDER',
    "for MAIL_TRANSPORT=graph (the product's shared mailbox)",
  );
  if (!ADDRESS.test(sender))
    throw new MailConfigError('MAIL_GRAPH_SENDER must be a plain email address.');
  const tenantId = required(env, 'AZURE_TENANT_ID', 'for MAIL_TRANSPORT=graph');
  const clientId = required(
    env,
    'AZURE_CLIENT_ID',
    "for MAIL_TRANSPORT=graph (the product's own Entra app)",
  );

  // The federated token wins whenever it is there, even if a client secret is also set: a pod
  // may keep its login flow's secret while its mail uses the federated credential.
  const tokenFilePath = value(env, 'AZURE_FEDERATED_TOKEN_FILE');
  if (tokenFilePath !== undefined) {
    return {
      transport: 'graph',
      sender,
      tenantId,
      clientId,
      credential: { kind: 'workload-identity', tokenFilePath },
    };
  }

  const clientSecret = value(env, 'AZURE_CLIENT_SECRET');
  if (clientSecret !== undefined) {
    if (isProduction(env)) {
      throw new MailConfigError(
        'A client secret is refused when NODE_ENV=production: mail authenticates with workload identity federation ' +
          '(set AZURE_FEDERATED_TOKEN_FILE), not a stored secret.',
      );
    }
    return {
      transport: 'graph',
      sender,
      tenantId,
      clientId,
      credential: { kind: 'client-secret', clientSecret },
    };
  }

  throw new MailConfigError(
    'No Graph credential: set AZURE_FEDERATED_TOKEN_FILE (workload identity, production) or ' +
      'AZURE_CLIENT_SECRET (local testing only).',
  );
}

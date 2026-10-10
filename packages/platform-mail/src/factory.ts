import { readMailConfig, type GraphConfig, type MailEnv } from './config';
import { MailConfigError } from './errors';
import { createGraphSender, type TokenProvider } from './graph';
import type { EmailSender } from './message';
// Type-only: erased at compile time, so it never loads `smtp` (which refuses to in production).
import type * as SmtpModule from './smtp';
import type * as AzureIdentity from '@azure/identity';

export interface CreateEmailSenderOptions {
  /** Test seam; defaults to `process.env`. Configuration comes from the environment only. */
  env?: MailEnv;
  /** Test seam: replaces the `@azure/identity` credential. */
  credential?: TokenProvider;
  /** Test seam: replaces the global `fetch` used by the Graph transport. */
  fetch?: typeof fetch;
  /** Test seam: replaces the lazy `require('./smtp')`, which a TypeScript test runner cannot resolve. */
  loadSmtp?: () => typeof SmtpModule;
}

/**
 * The `EmailSender` for this process, chosen by `MAIL_TRANSPORT` (see {@link readMailConfig}
 * for every variable). Throws `MailConfigError` naming what is wrong; nothing is sent.
 *
 * Optional peers are loaded here, lazily, so a process that uses `graph` never needs
 * `nodemailer` and one that uses `smtp` never needs `@azure/identity` — and the `smtp` module
 * (which refuses to load in production) is never even required in production.
 */
export function createEmailSender(options: CreateEmailSenderOptions = {}): EmailSender {
  const config = readMailConfig(options.env ?? process.env);

  if (config.transport === 'smtp') {
    const { createSmtpSender } = (
      options.loadSmtp ??
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy, see above
      (() => require('./smtp') as typeof SmtpModule)
    )();
    return createSmtpSender({ host: config.host, port: config.port, from: config.from });
  }

  const credential = options.credential ?? graphCredential(config);
  return createGraphSender({
    sender: config.sender,
    credential,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}

function graphCredential(config: GraphConfig): TokenProvider {
  let identity: typeof AzureIdentity;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional peer, loaded lazily
    identity = require('@azure/identity') as typeof AzureIdentity;
  } catch {
    throw new MailConfigError(
      'MAIL_TRANSPORT=graph requires "@azure/identity" to be installed. Add it to your dependencies.',
    );
  }

  if (config.credential.kind === 'workload-identity') {
    return new identity.WorkloadIdentityCredential({
      tenantId: config.tenantId,
      clientId: config.clientId,
      tokenFilePath: config.credential.tokenFilePath,
    });
  }
  return new identity.ClientSecretCredential(
    config.tenantId,
    config.clientId,
    config.credential.clientSecret,
  );
}

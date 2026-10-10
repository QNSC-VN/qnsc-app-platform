import { describe, expect, it } from 'vitest';
import { readMailConfig } from './config';
import { MailConfigError } from './errors';

const GRAPH = {
  MAIL_TRANSPORT: 'graph',
  MAIL_GRAPH_SENDER: 'noreply-academy@qnsc.vn',
  AZURE_TENANT_ID: '11111111-1111-1111-1111-111111111111',
  AZURE_CLIENT_ID: '22222222-2222-2222-2222-222222222222',
};

function failure(env: Record<string, string | undefined>): string {
  try {
    readMailConfig(env);
  } catch (err) {
    expect(err).toBeInstanceOf(MailConfigError);
    return (err as Error).message;
  }
  throw new Error('expected a MailConfigError');
}

describe('readMailConfig: graph', () => {
  it('uses the federated token file when present', () => {
    const config = readMailConfig({
      ...GRAPH,
      AZURE_FEDERATED_TOKEN_FILE: '/var/run/secrets/azure/tokens/azure-identity-token',
    });
    expect(config).toEqual({
      transport: 'graph',
      sender: 'noreply-academy@qnsc.vn',
      tenantId: GRAPH.AZURE_TENANT_ID,
      clientId: GRAPH.AZURE_CLIENT_ID,
      credential: {
        kind: 'workload-identity',
        tokenFilePath: '/var/run/secrets/azure/tokens/azure-identity-token',
      },
    });
  });

  it('prefers the federated token over a client secret, even outside production', () => {
    // A pod may keep its login flow's secret while its mail uses the federated credential.
    const config = readMailConfig({
      ...GRAPH,
      AZURE_FEDERATED_TOKEN_FILE: '/t',
      AZURE_CLIENT_SECRET: 'x',
    });
    expect(config).toMatchObject({ credential: { kind: 'workload-identity' } });
  });

  it('prefers the federated token over a client secret in production too, without error', () => {
    const config = readMailConfig({
      ...GRAPH,
      NODE_ENV: 'production',
      AZURE_FEDERATED_TOKEN_FILE: '/t',
      AZURE_CLIENT_SECRET: 'x',
    });
    expect(config).toMatchObject({ credential: { kind: 'workload-identity' } });
  });

  it('accepts a client secret for local testing', () => {
    const config = readMailConfig({
      ...GRAPH,
      NODE_ENV: 'development',
      AZURE_CLIENT_SECRET: 'local-secret',
    });
    expect(config).toMatchObject({
      credential: { kind: 'client-secret', clientSecret: 'local-secret' },
    });
  });

  it('refuses a client secret in production, naming the alternative', () => {
    const message = failure({ ...GRAPH, NODE_ENV: 'production', AZURE_CLIENT_SECRET: 'x' });
    expect(message).toMatch(/refused when NODE_ENV=production/);
    expect(message).toMatch(/AZURE_FEDERATED_TOKEN_FILE/);
    expect(message).not.toContain('=x');
  });

  it('names both credential options when there is none', () => {
    const message = failure(GRAPH);
    expect(message).toMatch(/AZURE_FEDERATED_TOKEN_FILE/);
    expect(message).toMatch(/AZURE_CLIENT_SECRET/);
  });

  it.each(['MAIL_GRAPH_SENDER', 'AZURE_TENANT_ID', 'AZURE_CLIENT_ID'])('requires %s', (name) => {
    expect(failure({ ...GRAPH, AZURE_FEDERATED_TOKEN_FILE: '/t', [name]: undefined })).toContain(
      name,
    );
    expect(failure({ ...GRAPH, AZURE_FEDERATED_TOKEN_FILE: '/t', [name]: '  ' })).toContain(name);
  });

  it('rejects a sender that is not a plain address', () => {
    expect(
      failure({
        ...GRAPH,
        AZURE_FEDERATED_TOKEN_FILE: '/t',
        MAIL_GRAPH_SENDER: 'Academy <a@qnsc.vn>',
      }),
    ).toMatch(/MAIL_GRAPH_SENDER/);
  });
});

describe('readMailConfig: transport selection', () => {
  it('requires MAIL_TRANSPORT: there is no silent default', () => {
    expect(failure({})).toMatch(/MAIL_TRANSPORT is required/);
  });

  it('rejects an unknown transport, including the ones that are future work', () => {
    for (const name of ['cloudflare', 'resend', 'ses', 'GRAPH']) {
      expect(failure({ MAIL_TRANSPORT: name })).toMatch(/not supported/);
    }
  });
});

describe('readMailConfig: smtp', () => {
  it('defaults to Mailpit', () => {
    expect(readMailConfig({ MAIL_TRANSPORT: 'smtp' })).toEqual({
      transport: 'smtp',
      host: 'localhost',
      port: 1025,
      from: 'noreply@localhost.test',
    });
  });

  it('takes host, port and from from the environment', () => {
    expect(
      readMailConfig({
        MAIL_TRANSPORT: 'smtp',
        MAIL_SMTP_HOST: 'mailpit',
        MAIL_SMTP_PORT: '2525',
        MAIL_SMTP_FROM: 'dev@example.test',
      }),
    ).toEqual({ transport: 'smtp', host: 'mailpit', port: 2525, from: 'dev@example.test' });
  });

  it('REFUSES to be configured when NODE_ENV=production', () => {
    expect(failure({ MAIL_TRANSPORT: 'smtp', NODE_ENV: 'production' })).toMatch(
      /refused when NODE_ENV=production/,
    );
  });

  it.each(['0', '70000', 'abc', '25.5'])('rejects MAIL_SMTP_PORT=%s', (port) => {
    expect(failure({ MAIL_TRANSPORT: 'smtp', MAIL_SMTP_PORT: port })).toMatch(/MAIL_SMTP_PORT/);
  });
});

describe('readMailConfig: control characters (L1)', () => {
  const base = { ...GRAPH, AZURE_FEDERATED_TOKEN_FILE: '/t' };

  it.each([
    ['MAIL_GRAPH_SENDER', 'noreply@qnsc.vn\r\nBcc: x@evil.test'],
    ['AZURE_TENANT_ID', '1111\u00002222'],
    ['AZURE_CLIENT_ID', 'abc\ndef'],
    ['AZURE_FEDERATED_TOKEN_FILE', '/var/run/secrets/\u0007token'],
    ['MAIL_TRANSPORT', 'gra\tph'],
  ])('rejects a control character inside %s, naming it', (name, bad) => {
    expect(failure({ ...base, [name]: bad })).toBe(`${name} contains a control character.`);
  });

  it.each([
    ['MAIL_SMTP_HOST', 'mail\u0000pit'],
    ['MAIL_SMTP_PORT', '10\n25'],
    ['MAIL_SMTP_FROM', 'dev@example.test\r\nRCPT TO:<x@y.z>'],
  ])('rejects a control character inside %s (smtp)', (name, bad) => {
    expect(failure({ MAIL_TRANSPORT: 'smtp', [name]: bad })).toContain('control character');
  });

  it('tolerates a stray trailing newline (a mounted file), trimming it', () => {
    const config = readMailConfig({ ...base, MAIL_GRAPH_SENDER: 'noreply-academy@qnsc.vn\n' });
    expect(config).toMatchObject({ sender: 'noreply-academy@qnsc.vn' });
  });

  it('never echoes the value in the error', () => {
    expect(failure({ ...base, AZURE_CLIENT_ID: 'secret-ish\u0000value' })).not.toContain(
      'secret-ish',
    );
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphServer } from './__helpers__/graph-server';
import { MailConfigError } from './errors';
import { createEmailSender } from './factory';
import { GRAPH_SCOPE } from './graph';
import { sampleMessage } from './testing';

const GRAPH_ENV = {
  MAIL_TRANSPORT: 'graph',
  MAIL_GRAPH_SENDER: 'noreply-academy@qnsc.vn',
  AZURE_TENANT_ID: '11111111-1111-1111-1111-111111111111',
  AZURE_CLIENT_ID: '22222222-2222-2222-2222-222222222222',
};

describe('createEmailSender: graph', () => {
  let server: GraphServer;
  beforeEach(async () => {
    server = new GraphServer();
    await server.start();
  });
  afterEach(() => server.stop());

  it('builds a sender for the configured mailbox, sending through the injected credential and fetch', async () => {
    const getToken = vi.fn(async () => ({ token: 'tok' }));
    const sender = createEmailSender({
      env: { ...GRAPH_ENV, AZURE_FEDERATED_TOKEN_FILE: '/never/read' },
      credential: { getToken },
      fetch: (input, init) =>
        fetch(String(input).replace('https://graph.microsoft.com/v1.0', server.baseUrl), init),
    });

    expect(sender.mailbox).toBe('noreply-academy@qnsc.vn');
    await sender.send(sampleMessage());

    expect(getToken).toHaveBeenCalledWith(GRAPH_SCOPE);
    expect(server.requests[0]?.url).toBe('/v1.0/users/noreply-academy%40qnsc.vn/sendMail');
  });

  it('constructs the real @azure/identity credentials from the environment (no network until the first send)', () => {
    expect(
      createEmailSender({
        env: { ...GRAPH_ENV, AZURE_FEDERATED_TOKEN_FILE: '/var/run/secrets/azure/tokens/token' },
      }).mailbox,
    ).toBe('noreply-academy@qnsc.vn');
    expect(
      createEmailSender({
        env: {
          ...GRAPH_ENV,
          NODE_ENV: 'development',
          AZURE_CLIENT_SECRET: 'generated-for-this-test',
        },
      }).mailbox,
    ).toBe('noreply-academy@qnsc.vn');
  });

  it('says what is missing instead of failing later at the first send', () => {
    expect(() => createEmailSender({ env: { MAIL_TRANSPORT: 'graph' } })).toThrow(MailConfigError);
    expect(() => createEmailSender({ env: { MAIL_TRANSPORT: 'graph' } })).toThrow(
      /MAIL_GRAPH_SENDER/,
    );
    expect(() => createEmailSender({ env: {} })).toThrow(/MAIL_TRANSPORT is required/);
  });

  it('refuses a client secret in production before building anything', () => {
    expect(() =>
      createEmailSender({
        env: { ...GRAPH_ENV, NODE_ENV: 'production', AZURE_CLIENT_SECRET: 'x' },
      }),
    ).toThrow(/refused when NODE_ENV=production/);
  });
});

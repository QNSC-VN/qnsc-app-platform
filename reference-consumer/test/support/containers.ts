import { randomBytes } from 'node:crypto';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

export interface Started {
  host: string;
  port: number;
  stop(): Promise<void>;
}

const hold = (c: StartedTestContainer): Pick<Started, 'host' | 'stop'> => ({
  host: c.getHost(),
  stop: async () => {
    await c.stop();
  },
});

/**
 * PostgreSQL 18, the Debian image (the family CloudNativePG runs). The superuser is called `migrator`
 * on purpose: it plays the migration Job's role, and the application connects as a separate, less
 * privileged role the tests create, so a missing GRANT in a package fails here.
 */
export async function startPostgres(): Promise<Started & { password: string; database: string }> {
  const password = randomBytes(18).toString('hex');
  const c = await new GenericContainer('postgres:18')
    .withEnvironment({ POSTGRES_USER: 'migrator', POSTGRES_PASSWORD: password, POSTGRES_DB: 'm6' })
    .withExposedPorts(5432)
    .withWaitStrategy(
      Wait.forAll([
        Wait.forListeningPorts(),
        Wait.forLogMessage(/database system is ready to accept connections/, 2),
      ]),
    )
    .withStartupTimeout(120_000)
    .start();
  return { ...hold(c), port: c.getMappedPort(5432), password, database: 'm6' };
}

export async function startValkey(): Promise<Started & { url: string }> {
  const c = await new GenericContainer('valkey/valkey:8-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(
      Wait.forAll([Wait.forListeningPorts(), Wait.forLogMessage(/Ready to accept connections/)]),
    )
    .withStartupTimeout(60_000)
    .start();
  const port = c.getMappedPort(6379);
  return { ...hold(c), port, url: `redis://${c.getHost()}:${port}` };
}

/** Mailpit: an SMTP sink (`smtp-dev`) with an HTTP API to read what arrived. */
export async function startMailpit(): Promise<
  Started & { smtpPort: number; api: string; messagesTo(address: string): Promise<MailpitMessage[]> }
> {
  const c = await new GenericContainer('axllent/mailpit:latest')
    .withExposedPorts(1025, 8025)
    .withWaitStrategy(Wait.forAll([Wait.forListeningPorts(), Wait.forHttp('/api/v1/info', 8025)]))
    .withStartupTimeout(60_000)
    .start();
  const api = `http://${c.getHost()}:${c.getMappedPort(8025)}`;
  return {
    ...hold(c),
    port: c.getMappedPort(1025),
    smtpPort: c.getMappedPort(1025),
    api,
    async messagesTo(address) {
      const res = await fetch(`${api}/api/v1/messages?limit=500`);
      const body = (await res.json()) as { messages: MailpitMessage[] };
      return body.messages.filter((m) => m.To.some((t) => t.Address === address));
    },
  };
}

export interface MailpitMessage {
  ID: string;
  /** The SMTP Message-ID, without angle brackets: what platform-mail logs as `messageId` (with them). */
  MessageID: string;
  To: { Address: string }[];
  Subject: string;
  Snippet: string;
}

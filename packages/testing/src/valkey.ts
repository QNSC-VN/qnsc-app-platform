import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { VALKEY_IMAGE } from './docker';

export interface StartValkeyOptions {
  /** Override the image. Default: {@link VALKEY_IMAGE}. */
  image?: string;
}

export interface ValkeyHarness {
  readonly host: string;
  readonly port: number;
  /** `redis://host:port` — Valkey speaks the Redis protocol, so ioredis connects with it as is. */
  readonly url: string;
  /** Run `valkey-cli <args>` inside the container and return its trimmed stdout. */
  command(...args: string[]): Promise<string>;
  /** Remove every key in every database. Use between tests. */
  flush(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Start a Valkey container.
 *
 * Deliberately returns no client: the harness must not pin an ioredis version on the packages
 * that use it. Connect with whatever client the package under test already depends on.
 */
export async function startValkey(options: StartValkeyOptions = {}): Promise<ValkeyHarness> {
  const started: StartedTestContainer = await new GenericContainer(options.image ?? VALKEY_IMAGE)
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .withStartupTimeout(60_000)
    .start();

  const host = started.getHost();
  const port = started.getMappedPort(6379);

  const command = async (...args: string[]): Promise<string> => {
    const result = await started.exec(['valkey-cli', ...args]);
    if (result.exitCode !== 0) {
      throw new Error(`valkey-cli ${args[0] ?? ''} failed (${result.exitCode}): ${result.output}`);
    }
    return result.output.trim();
  };

  return {
    host,
    port,
    url: `redis://${host}:${port}`,
    command,
    flush: async () => {
      await command('FLUSHALL');
    },
    stop: async () => {
      await started.stop();
    },
  };
}

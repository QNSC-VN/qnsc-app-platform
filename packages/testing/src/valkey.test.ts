import { connect } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dockerTestsEnabled } from './docker';
import { startValkey, type ValkeyHarness } from './valkey';

const enabled = await dockerTestsEnabled();

/** One RESP round trip over the mapped port: proves host:port is reachable from the test process. */
function ping(host: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port }, () => socket.write('PING\r\n'));
    socket.once('data', (data) => {
      socket.end();
      resolve(data.toString().trim());
    });
    socket.once('error', reject);
  });
}

describe.skipIf(!enabled)('startValkey', () => {
  let valkey: ValkeyHarness;

  beforeAll(async () => {
    valkey = await startValkey();
  }, 120_000);

  afterAll(async () => {
    await valkey?.stop();
  }, 60_000);

  it('is reachable on the mapped host and port', async () => {
    expect(await ping(valkey.host, valkey.port)).toBe('+PONG');
    expect(valkey.url).toBe(`redis://${valkey.host}:${valkey.port}`);
  });

  it('is Valkey 8', async () => {
    expect(await valkey.command('INFO', 'server')).toMatch(/valkey_version:8\./);
  });

  it('flush() removes every key', async () => {
    await valkey.command('SET', 'k', 'v');
    expect(await valkey.command('GET', 'k')).toBe('v');
    await valkey.flush();
    expect(await valkey.command('DBSIZE')).toBe('0');
  });
});

import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { assertNoRedirect, assertSafeUrl, oidcFetchUrls, SsrfError, type SsrfPolicy } from './ssrf';

const policy = (map: Record<string, string[]>): SsrfPolicy => ({
  allowLocalNetwork: false,
  resolve: async (h) => map[h] ?? [],
});
const P = policy({
  'idp.example': ['8.8.8.8'],
  metadata: ['169.254.169.254'],
  'rebind.example': ['8.8.8.8', '10.0.0.5'],
  'mapped.example': ['::ffff:7f00:1'],
});

describe("ssrf: Better Auth's classifier decides what is public", () => {
  it('accepts https hosts that resolve only to public addresses', async () => {
    expect(
      (await assertSafeUrl('https://idp.example/.well-known/openid-configuration', P)).host,
    ).toBe('idp.example');
    expect((await assertSafeUrl('https://[2606:4700::1111]/x', P)).hostname).toContain('2606');
  });

  it.each([
    ['http://idp.example/x', 'https is required'],
    ['https://user:pw@idp.example/x', 'credentials'],
    ['https://127.0.0.1/x', 'non-public'],
    ['https://[::1]/x', 'non-public'],
    ['https://10.0.0.5/x', 'non-public'],
    ['https://169.254.169.254/x', 'non-public'],
    ['https://100.64.0.1/x', 'non-public'], // CGNAT
    ['https://198.18.0.1/x', 'non-public'], // benchmarking 198.18.0.0/15
    ['https://198.19.255.255/x', 'non-public'],
    ['https://[::ffff:7f00:1]/x', 'non-public'], // IPv4-mapped loopback in hex form
    ['https://[::ffff:127.0.0.1]/x', 'non-public'],
    ['https://[64:ff9b::7f00:1]/x', 'non-public'], // NAT64 embedding 127.0.0.1
    ['https://[64:ff9b::a00:1]/x', 'non-public'], // NAT64 embedding 10.0.0.1
    ['https://[2002:7f00:1::1]/x', 'non-public'], // 6to4 embedding 127.0.0.1
    ['https://[2002:a00:1::1]/x', 'non-public'], // 6to4 embedding 10.0.0.1
    ['https://[fd00::1]/x', 'non-public'],
    ['https://[fe80::1]/x', 'non-public'],
    ['https://metadata/x', 'not public'], // cloud-metadata name
    ['https://metadata.google.internal/x', 'not public'],
    ['https://rebind.example/x', 'non-public'], // one private address among public ones
    ['https://mapped.example/x', 'non-public'], // a name that resolves to ::ffff:7f00:1
    ['https://nowhere.example/x', 'does not resolve'],
    ['not a url', 'not a URL'],
  ])('refuses %s', async (url, reason) => {
    const error = await assertSafeUrl(url, P).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SsrfError);
    expect((error as SsrfError).reason).toContain(reason);
  });

  it('the message that reaches an API caller is generic: no reason, no address', async () => {
    const error = (await assertSafeUrl('https://10.0.0.5/x', P).catch(
      (e: unknown) => e,
    )) as SsrfError;
    expect(error.message).toBe('That URL is not allowed for SSO.');
    expect(error.message).not.toMatch(/10\.0|private|resolve|loopback/i);
  });

  it('collects every URL the server would fetch', () => {
    expect(
      oidcFetchUrls(
        'https://i',
        JSON.stringify({ tokenEndpoint: 'https://t', jwksEndpoint: 'https://j', clientId: 'x' }),
      ),
    ).toEqual(['https://i', 'https://t', 'https://j']);
  });
});

describe('ssrf: redirects are not followed', () => {
  const serve = async (status: number, location?: string) => {
    const server = createServer((_req, res) => {
      res.writeHead(status, location ? { location } : {});
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    return {
      url: `http://127.0.0.1:${port}/`,
      stop: () => new Promise<void>((r) => server.close(() => r())),
    };
  };

  it('refuses a URL that redirects (to a private address), accepts one that answers', async () => {
    const redirecting = await serve(302, 'http://169.254.169.254/latest/meta-data');
    const plain = await serve(200);
    try {
      await expect(assertNoRedirect(redirecting.url)).rejects.toThrow(SsrfError);
      await expect(assertNoRedirect(plain.url)).resolves.toBeUndefined();
    } finally {
      await redirecting.stop();
      await plain.stop();
    }
  });

  it("lets a host that does not answer through (Better Auth's own discovery will fail on it)", async () => {
    await expect(assertNoRedirect('http://127.0.0.1:9/')).resolves.toBeUndefined();
  });
});

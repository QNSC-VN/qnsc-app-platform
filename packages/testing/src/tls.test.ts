import { X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateTls, TLS_SERVER_NAME } from './tls';

describe('generateTls', () => {
  it('issues a server certificate signed by the generated CA, valid for localhost and loopback', async () => {
    const tls = await generateTls();
    const ca = new X509Certificate(tls.caCertPem);
    const server = new X509Certificate(tls.serverCertPem);

    expect(ca.ca).toBe(true);
    expect(server.ca).toBe(false);
    expect(server.verify(ca.publicKey)).toBe(true);
    expect(server.checkIssued(ca)).toBe(true);
    expect(server.checkHost(TLS_SERVER_NAME)).toBe(TLS_SERVER_NAME);
    expect(server.checkIP('127.0.0.1')).toBe('127.0.0.1');
    expect(server.checkIP('::1')).toBeDefined();
    expect(server.checkHost('example.com')).toBeUndefined();
  });

  it('is not signed by an unrelated CA', async () => {
    const [a, b] = await Promise.all([generateTls(), generateTls()]);
    const server = new X509Certificate(a.serverCertPem);
    expect(server.verify(new X509Certificate(b.caCertPem).publicKey)).toBe(false);
  });

  it('generates fresh key material on every call', async () => {
    const [a, b] = await Promise.all([generateTls(), generateTls()]);
    expect(a.caCertPem).not.toBe(b.caCertPem);
    expect(a.serverKeyPem).not.toBe(b.serverKeyPem);
  });

  it('emits a PKCS#8 private key PEM', async () => {
    const { serverKeyPem } = await generateTls();
    expect(serverKeyPem).toMatch(
      /^-----BEGIN PRIVATE KEY-----\n[\s\S]+\n-----END PRIVATE KEY-----\n$/,
    );
  });
});

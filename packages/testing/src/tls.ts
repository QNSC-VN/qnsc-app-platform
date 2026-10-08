// @peculiar/x509 resolves its DI container through tsyringe, which requires this polyfill
// to be loaded first.
import 'reflect-metadata';
import { randomBytes, webcrypto } from 'node:crypto';
import * as x509 from '@peculiar/x509';

x509.cryptoProvider.set(webcrypto as unknown as Parameters<typeof x509.cryptoProvider.set>[0]);

const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;

/** Every name the generated server certificate is valid for. */
export const TLS_SERVER_NAME = 'localhost';

export interface GeneratedTls {
  /** PEM of the throwaway CA. Hand this to the client as its trust anchor. */
  caCertPem: string;
  /** PEM server certificate, signed by the CA, valid for `localhost`, 127.0.0.1 and ::1. */
  serverCertPem: string;
  /** PKCS#8 PEM private key of the server certificate. */
  serverKeyPem: string;
}

function toPem(label: string, der: ArrayBuffer): string {
  const body = Buffer.from(der)
    .toString('base64')
    .replace(/(.{64})/g, '$1\n');
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

/** Positive, random, 16-byte serial (top bit cleared so the DER integer stays positive). */
function serial(): string {
  const bytes = randomBytes(16);
  bytes[0] = (bytes[0] ?? 0) & 0x7f;
  return bytes.toString('hex');
}

/**
 * Generate a fresh self-signed CA and a server certificate signed by it.
 *
 * In-process, with no `openssl` binary and nothing on disk, so it behaves the same on a laptop
 * and on a GitHub-hosted runner. Everything is regenerated per call: no key material is ever
 * committed or reused between runs.
 */
export async function generateTls(): Promise<GeneratedTls> {
  const notBefore = new Date(Date.now() - 60 * 60 * 1000);
  const notAfter = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const caKeys = await webcrypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);
  const ca = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: serial(),
    name: 'CN=app-platform testing CA',
    notBefore,
    notAfter,
    signingAlgorithm: ALGORITHM,
    keys: caKeys,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true,
      ),
      await x509.SubjectKeyIdentifierExtension.create(caKeys.publicKey),
    ],
  });

  const serverKeys = await webcrypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);
  const server = await x509.X509CertificateGenerator.create({
    serialNumber: serial(),
    subject: `CN=${TLS_SERVER_NAME}`,
    issuer: ca.subject,
    notBefore,
    notAfter,
    signingAlgorithm: ALGORITHM,
    publicKey: serverKeys.publicKey,
    signingKey: caKeys.privateKey,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth], false),
      new x509.SubjectAlternativeNameExtension([
        { type: 'dns', value: TLS_SERVER_NAME },
        { type: 'ip', value: '127.0.0.1' },
        { type: 'ip', value: '::1' },
      ]),
      await x509.AuthorityKeyIdentifierExtension.create(ca, false),
      await x509.SubjectKeyIdentifierExtension.create(serverKeys.publicKey),
    ],
  });

  return {
    caCertPem: ca.toString('pem'),
    serverCertPem: server.toString('pem'),
    serverKeyPem: toPem(
      'PRIVATE KEY',
      await webcrypto.subtle.exportKey('pkcs8', serverKeys.privateKey),
    ),
  };
}

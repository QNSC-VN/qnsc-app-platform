import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';

/**
 * A throwaway OpenID Provider standing in for Microsoft Entra ID and for a partner IdP.
 * No real tenant, secret or network is involved; every key and code is generated per run.
 *
 *   Entra-shaped:   /<tenant>/oauth2/v2.0/{authorize,token}  /<tenant>/discovery/v2.0/keys
 *   Generic OIDC:   /.well-known/openid-configuration  /oidc/{authorize,token,jwks,userinfo}
 *
 * What it can prove: Better Auth's request/response handling, PKCE, state, claim mapping,
 * provisioning. What it CANNOT prove: Entra's own behaviour (single-tenant app registration
 * refusing foreign tenants, B2B guests, optional-claim configuration). Those are listed in the ADR
 * as needing a manual check against the real tenant.
 */
export interface Identity {
  sub: string;
  email?: string;
  name?: string;
  emailVerified?: boolean;
  /** Entra only. */
  oid?: string;
  tid?: string;
  /** Extra claims copied into the id_token (for example `groups`, `roles`). */
  claims?: Record<string, unknown>;
}

interface Grant {
  identity: Identity;
  clientId: string;
  redirectUri: string;
  codeChallenge?: string;
  nonce?: string;
  kind: 'entra' | 'oidc';
  tenant?: string;
}

export interface MockIdp {
  base: string;
  /** The identity the NEXT authorisation will sign in. */
  loginAs(identity: Identity): void;
  /** Requests received, in order, for assertions about what Better Auth asked for. */
  readonly requests: Array<{ method: string; path: string; form?: Record<string, string> }>;
  stop(): Promise<void>;
}

async function readForm(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return Object.fromEntries(new URLSearchParams(raw));
}

export async function startMockIdp(): Promise<MockIdp> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const kid = randomBytes(6).toString('hex');
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  const grants = new Map<string, Grant>();
  const requests: MockIdp['requests'] = [];
  let next: Identity | undefined;
  let base = '';

  const send = (
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };

  const sign = (key: CryptoKey, claims: Record<string, unknown>) =>
    new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid }).sign(key);

  const authorize = (
    url: URL,
    kind: Grant['kind'],
    tenant: string | undefined,
    res: ServerResponse,
  ) => {
    if (!next) return send(res, 400, { error: 'test did not call loginAs()' });
    const redirectUri = url.searchParams.get('redirect_uri')!;
    const code = randomBytes(16).toString('hex');
    grants.set(code, {
      identity: next,
      clientId: url.searchParams.get('client_id')!,
      redirectUri,
      codeChallenge: url.searchParams.get('code_challenge') ?? undefined,
      nonce: url.searchParams.get('nonce') ?? undefined,
      kind,
      tenant,
    });
    const back = new URL(redirectUri);
    back.searchParams.set('code', code);
    back.searchParams.set('state', url.searchParams.get('state')!);
    res.writeHead(302, { location: back.toString() });
    res.end();
  };

  const token = async (form: Record<string, string>, res: ServerResponse) => {
    const grant = grants.get(form['code'] ?? '');
    if (!grant) return send(res, 400, { error: 'invalid_grant' });
    grants.delete(form['code']!);
    if (grant.codeChallenge) {
      const expected = createHash('sha256')
        .update(form['code_verifier'] ?? '')
        .digest('base64url');
      if (expected !== grant.codeChallenge)
        return send(res, 400, { error: 'invalid_grant', detail: 'PKCE' });
    }
    const now = Math.floor(Date.now() / 1000);
    const { identity } = grant;
    const claims: Record<string, unknown> =
      grant.kind === 'entra'
        ? {
            iss: `${base}/${identity.tid ?? grant.tenant}/v2.0`,
            aud: grant.clientId,
            sub: identity.sub,
            oid: identity.oid ?? identity.sub,
            tid: identity.tid ?? grant.tenant,
            ...(identity.email ? { email: identity.email } : {}),
            name: identity.name,
            preferred_username: identity.email,
            ...identity.claims,
          }
        : {
            iss: `${base}/oidc`,
            aud: grant.clientId,
            sub: identity.sub,
            email: identity.email,
            email_verified: identity.emailVerified ?? true,
            name: identity.name,
            ...identity.claims,
          };
    const idToken = await sign(privateKey, {
      ...claims,
      iat: now,
      exp: now + 600,
      ...(grant.nonce ? { nonce: grant.nonce } : {}),
    });
    send(res, 200, {
      access_token: `at-${randomBytes(8).toString('hex')}`,
      id_token: idToken,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'openid profile email',
    });
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url!, base || 'http://127.0.0.1');
      const method = req.method!;
      const form = method === 'POST' ? await readForm(req) : undefined;
      requests.push({ method, path: url.pathname, ...(form ? { form } : {}) });

      const entra = url.pathname.match(
        /^\/([^/]+)\/(oauth2\/v2\.0\/(authorize|token)|discovery\/v2\.0\/keys)$/,
      );
      if (entra) {
        const [, tenant, , leaf] = entra;
        if (entra[2] === 'discovery/v2.0/keys') return send(res, 200, { keys: [jwk] });
        if (leaf === 'authorize') return authorize(url, 'entra', tenant, res);
        return token(form ?? {}, res);
      }
      if (url.pathname === '/.well-known/openid-configuration') {
        return send(res, 200, {
          issuer: `${base}/oidc`,
          authorization_endpoint: `${base}/oidc/authorize`,
          token_endpoint: `${base}/oidc/token`,
          jwks_uri: `${base}/oidc/jwks`,
          userinfo_endpoint: `${base}/oidc/userinfo`,
          id_token_signing_alg_values_supported: ['RS256'],
          token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
          code_challenge_methods_supported: ['S256'],
        });
      }
      if (url.pathname === '/oidc/authorize') return authorize(url, 'oidc', undefined, res);
      if (url.pathname === '/oidc/token') return token(form ?? {}, res);
      if (url.pathname === '/oidc/jwks') return send(res, 200, { keys: [jwk] });
      if (url.pathname === '/oidc/userinfo') return send(res, 200, { sub: 'userinfo-not-used' });
      return send(res, 404, { error: 'not_found', path: url.pathname });
    })().catch((err: unknown) => send(res, 500, { error: String(err) }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  base = `http://127.0.0.1:${port}`;

  return {
    base,
    loginAs(identity) {
      next = identity;
    },
    requests,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

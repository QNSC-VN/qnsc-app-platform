import { fromNodeHeaders } from 'better-auth/node';
import { clientIp } from '@quynhonsemiconductor/platform-http';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CLIENT_IP_HEADER, type Identity } from '../identity/create-identity';

export const AUTH_BASE_PATH = '/api/auth';

/**
 * Mounts `auth.handler` on Fastify as an ENCAPSULATED plugin (identity plan A.2, corrected).
 *
 * Two things differ from the plan's sketch:
 *
 *  1. The body must reach Better Auth UNPARSED. The sketch registers the route on the root
 *     instance, so Fastify's JSON parser has already consumed the body and `JSON.stringify(
 *     request.body)` re-serialises it. That is fine for JSON, but Fastify has no
 *     `application/x-www-form-urlencoded` parser at all, so a SAML/OIDC `form_post` callback (the
 *     sso plugin's own protocol) gets 415 before the handler runs (test C4 "a bare Fastify…").
 *     Inside this plugin every content type is handed over as a raw Buffer and the original bytes
 *     become the `Request` body, whatever their type. Encapsulation keeps the rest of the app's
 *     parsers untouched.
 *
 *  2. The client address is resolved HERE with `clientIp()` and written into
 *     {@link CLIENT_IP_HEADER}; whatever the client sent under that name is discarded first.
 *     Better Auth reads that one header (`advanced.ipAddress.ipAddressHeaders`) for rate-limit
 *     keys and the session's IP — see criterion 10 in the ADR.
 *
 * (Repeated `Set-Cookie` headers: the sketch's `headers.forEach` copy also works on Node 24, where
 * iteration yields each cookie separately. They are copied with `getSetCookie()` anyway, so the
 * code does not depend on that.)
 */
export async function registerAuthHandler(fastify: FastifyInstance, auth: Identity): Promise<void> {
  await fastify.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

    scope.route({
      method: ['GET', 'POST'],
      url: `${AUTH_BASE_PATH}/*`,
      handler: async (request: FastifyRequest, reply: FastifyReply) => {
        const headers = fromNodeHeaders(request.headers);
        headers.delete(CLIENT_IP_HEADER);
        headers.set(CLIENT_IP_HEADER, clientIp(request));

        // Trust the proxy chain for protocol/host only through Fastify's own `trustProxy`.
        const url = new URL(request.url, `${request.protocol}://${request.hostname}`);
        const body = request.method === 'GET' ? undefined : (request.body as Buffer | undefined);
        const response = await auth.handler(
          new Request(url, {
            method: request.method,
            headers,
            ...(body && body.length > 0 ? { body: new Uint8Array(body) } : {}),
          }),
        );

        reply.status(response.status);
        // `Set-Cookie` is the one header that repeats: copy it as an array.
        const cookies = response.headers.getSetCookie();
        response.headers.forEach((value, key) => {
          if (key.toLowerCase() !== 'set-cookie') void reply.header(key, value);
        });
        if (cookies.length > 0) void reply.header('set-cookie', cookies);
        return reply.send(response.body ? Buffer.from(await response.arrayBuffer()) : null);
      },
    });
  });
}

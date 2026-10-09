import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { fromNodeHeaders } from 'better-auth/node';
import { UnauthorizedException } from '@quynhonsemiconductor/platform-http';
import type { FastifyRequest } from 'fastify';
import type { Identity } from '../identity/create-identity';

export const AUTH = Symbol.for('@quynhonsemiconductor/identity:auth');
const PUBLIC = 'identity:public';

/** Opt a route out of the global {@link SessionGuard}. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC, true);

type SessionResult = NonNullable<Awaited<ReturnType<Identity['api']['getSession']>>>;
export type RequestWithSession = FastifyRequest & { session?: SessionResult };

/** The authenticated session (`{ session, user }`); only valid on a non-`@Public()` route. */
export const CurrentSession = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<RequestWithSession>().session;
});

/**
 * Global guard: every route needs a session unless marked `@Public()`. Authentication only —
 * authorization stays in the product's own guard, which reads `@CurrentSession()`.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(AUTH) private readonly auth: Identity,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, [ctx.getHandler(), ctx.getClass()])) {
      return true;
    }
    const req = ctx.switchToHttp().getRequest<RequestWithSession>();
    const session = await this.auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session) throw new UnauthorizedException('AUTH_UNAUTHENTICATED', 'Sign in required');
    req.session = session;
    return true;
  }
}

import {
  type ExecutionContext,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ValkeyService } from '@qnsc-vn/platform-cache';
import { AUTH_CONTEXT, type AuthContextSetter } from './auth-context';

/**
 * JWT auth guard.
 * Verifies the Bearer access token, then populates request context with
 * contextId / userId / sessionId so downstream scoping works correctly.
 * Also checks the access-token denylist in Valkey (set on logout).
 *
 * Pair with @Public() decorator to opt-out individual routes.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(
    @Inject(AUTH_CONTEXT) private readonly ctx: AuthContextSetter,
    @Inject(ValkeyService) private readonly valkey: ValkeyService,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    let result: boolean;
    try {
      result = await (super.canActivate(context) as Promise<boolean>);
    } catch (err) {
      // Re-throw expected auth failures as-is; convert infra errors to 401 so
      // NestJS never leaks a 500 to unauthenticated callers.
      if (err instanceof UnauthorizedException) throw err;
      this.logger.error({ err }, 'JWT strategy error during canActivate');
      throw new UnauthorizedException('Authentication service unavailable');
    }
    if (!result) return false;

    const req = context.switchToHttp().getRequest<{ user: { jti: string; sub: string } }>();
    try {
      // Check both token-level (logout) and user-level (suspension/deactivation) denylist.
      // Parallel lookups: saves ~1 RTT per authenticated request.
      const [tokenRevoked, userRevoked] = await Promise.all([
        this.valkey.isTokenDenied(req.user.jti),
        this.valkey.isUserRevoked(req.user.sub),
      ]);
      if (tokenRevoked || userRevoked) {
        throw new UnauthorizedException('Token has been revoked');
      }
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      // Denylist is best-effort. If Valkey is unavailable we fail open so
      // valid users aren't blocked — tokens still expire via their JWT exp claim.
      this.logger.warn({ err }, 'Token denylist check failed; failing open');
    }

    return true;
  }

  handleRequest<TUser extends { sub: string; contextId: string | null; sessionId: string }>(
    err: Error | null,
    user: TUser | false,
  ): TUser {
    if (err) {
      // Normalize unexpected infrastructure errors — don't re-throw raw DB/cache
      // errors which would produce a 500. Expected auth errors are UnauthorizedException.
      if (err instanceof UnauthorizedException) throw err;
      this.logger.error({ err }, 'Unexpected error in JWT handleRequest');
      throw new UnauthorizedException('Invalid or expired access token');
    }
    if (!user) {
      throw new UnauthorizedException('Invalid or expired access token');
    }

    // Populate request context after successful token verification
    this.ctx.setAuthContext(user.contextId, user.sub, user.sessionId);

    return user;
  }
}

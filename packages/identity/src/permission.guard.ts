import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSION_KEY } from './metadata';
import type { JwtPayload } from './jwt-payload';
import { PERMISSION_CHECKER, permissionGrants, type PermissionChecker } from './permissions';

/**
 * Permission guard — reads the required permission code from @RequirePermission()
 * and verifies the caller's JWT claims (permissions[] embedded at mint time).
 *
 * Uses the wildcard-aware {@link permissionGrants} by default; a product may
 * override the semantics by providing {@link PERMISSION_CHECKER}.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  private readonly logger = new Logger(PermissionGuard.name);
  private readonly checker: PermissionChecker;

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Optional() @Inject(PERMISSION_CHECKER) checker?: PermissionChecker,
  ) {
    this.checker = checker ?? permissionGrants;
  }

  canActivate(context: ExecutionContext): boolean {
    const requiredPermission = this.reflector.getAllAndOverride<string | undefined>(
      PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredPermission) return true;

    const request = context.switchToHttp().getRequest<{ user?: JwtPayload }>();
    const user = request.user;

    const permissions = user?.claims?.permissions;
    if (!Array.isArray(permissions) || permissions.length === 0) {
      this.logger.warn({ requiredPermission }, 'PermissionGuard: no permissions in JWT');
      throw new ForbiddenException('Insufficient permissions');
    }

    if (!this.checker(permissions as string[], requiredPermission)) {
      this.logger.warn({ userId: user?.sub, requiredPermission }, 'PermissionGuard: access denied');
      throw new ForbiddenException('Insufficient permissions');
    }

    return true;
  }
}

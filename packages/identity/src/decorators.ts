import {
  SetMetadata,
  applyDecorators,
  UseGuards,
  createParamDecorator,
  type ExecutionContext,
} from '@nestjs/common';
import { ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from './jwt.guard';
import { PermissionGuard } from './permission.guard';
import { IS_PUBLIC_KEY, PERMISSION_KEY } from './metadata';
import type { JwtPayload } from './jwt-payload';

/** Mark a route as unauthenticated (skip JwtAuthGuard). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Require a specific permission code (RBAC check via PermissionGuard). */
export const RequirePermission = (permission: string) => SetMetadata(PERMISSION_KEY, permission);

/**
 * Extract the authenticated user's JWT payload from the request.
 * Only use on routes protected by @Auth() or JwtAuthGuard.
 *
 * @example
 * async getMe(@CurrentUser() user: JwtPayload) { ... }
 */
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): JwtPayload => {
  const request = ctx.switchToHttp().getRequest<{ user: JwtPayload }>();
  return request.user;
});

// ── Swagger error-response shortcuts ──────────────────────────────────────────

type HttpErrorCode = 400 | 401 | 403 | 404 | 409 | 422 | 429;

const HTTP_ERROR_DESCRIPTIONS: Record<HttpErrorCode, string> = {
  400: 'Bad Request — validation error or malformed input',
  401: 'Unauthorized — missing or invalid authentication',
  403: 'Forbidden — insufficient permissions',
  404: 'Not Found',
  409: 'Conflict — duplicate record or state conflict',
  422: 'Unprocessable — business rule violation',
  429: 'Too Many Requests — rate limit exceeded',
};

/**
 * Attach standard @ApiResponse decorators in one call.
 *
 * @example
 * // Authenticated write with conflict risk:
 * @ApiCommonErrors(400, 401, 403, 404, 409)
 */
export const ApiCommonErrors = (...codes: HttpErrorCode[]) =>
  applyDecorators(
    ...codes.map((c) => ApiResponse({ status: c, description: HTTP_ERROR_DESCRIPTIONS[c] })),
  );

/** Apply JWT auth + permission guard + Swagger bearer annotation in one decorator. */
export const Auth = (permission?: string) =>
  applyDecorators(
    ...[
      UseGuards(JwtAuthGuard, PermissionGuard),
      ApiBearerAuth('access-token'),
      ...(permission ? [RequirePermission(permission)] : []),
    ],
  );

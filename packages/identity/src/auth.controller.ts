import { Body, Controller, Get, HttpCode, Inject, Patch, Post, Req, Res } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RateLimit, UnauthorizedException } from '@qnsc/platform-http';
import type { FastifyReply, FastifyRequest } from 'fastify';
import '@fastify/cookie';
import { AuthService } from './auth.service';
import { Auth, ApiCommonErrors, CurrentUser, Public } from './decorators';
import type { JwtPayload } from './jwt-payload';
import {
  ACCESS_SERVICE,
  WORKSPACE_SERVICE,
  type IAccessService,
  type IWorkspaceService,
} from './service-ports';
import {
  AuthTokenResponseDto,
  DevLoginDto,
  SsoLoginDto,
  SwitchWorkspaceDto,
  UpdateProfileDto,
  UserProfileResponseDto,
} from './auth.dto';

const REFRESH_COOKIE = 'refresh_token';
const CSRF_COOKIE = 'csrf_token';

const REMEMBER_ME_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

const COOKIE_BASE = {
  httpOnly: true,
  path: '/v1/auth',
} as const;

/**
 * Shared auth HTTP surface for QNSC product backends.
 *
 * Behaviour-preserving port of rally's `AuthController`: cookie-based refresh
 * rotation, SSO/dev login, workspace switching, logout(-all), and profile
 * read/update. Depends only on the identity ports ({@link ACCESS_SERVICE},
 * {@link WORKSPACE_SERVICE}) so each product binds its own concrete services.
 *
 * Requires `@fastify/cookie` to be registered on the Fastify instance and the
 * global {@link RateLimitGuard} to be active for the `@RateLimit` tiers to bite.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(ACCESS_SERVICE) private readonly accessService: IAccessService,
    @Inject(WORKSPACE_SERVICE) private readonly workspaceService: IWorkspaceService,
  ) {}

  private buildRefreshCookieOptions(req: FastifyRequest, maxAge: number) {
    const forwardedProto = req.headers['x-forwarded-proto'];
    const isSecureRequest =
      req.protocol === 'https' ||
      (typeof forwardedProto === 'string' &&
        forwardedProto.split(',').some((v) => v.trim() === 'https'));

    const originHeader = req.headers.origin;
    let isCrossSite = false;

    if (typeof originHeader === 'string' && req.headers.host) {
      try {
        isCrossSite = new URL(originHeader).host !== req.headers.host;
      } catch {
        isCrossSite = false;
      }
    }

    const sameSite = isCrossSite ? 'none' : 'lax';
    const secure = isSecureRequest || sameSite === 'none';

    return {
      ...COOKIE_BASE,
      sameSite,
      secure,
      maxAge,
    } as const;
  }

  private buildCsrfCookieOptions(req: FastifyRequest, maxAge: number) {
    const opts = this.buildRefreshCookieOptions(req, maxAge);
    // csrf_token must be JS-readable (httpOnly: false) and accessible site-wide (path: /)
    return { ...opts, httpOnly: false, path: '/' };
  }

  // ── POST /auth/sso ─────────────────────────────────────────────────────────

  @Post('sso')
  @Public()
  @RateLimit('AUTH_LOGIN')
  @HttpCode(200)
  @ApiOperation({ summary: 'Authenticate with Microsoft Entra ID (SSO)' })
  @ApiBody({ type: SsoLoginDto })
  @ApiResponse({ status: 200, type: AuthTokenResponseDto })
  @ApiCommonErrors(400, 401, 422)
  async ssoLogin(
    @Body() dto: SsoLoginDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthTokenResponseDto> {
    const result = await this.authService.ssoLogin(dto.idToken, req.ip);

    reply.setCookie(
      REFRESH_COOKIE,
      result.refreshToken,
      this.buildRefreshCookieOptions(req, REMEMBER_ME_TTL_SECONDS),
    );
    reply.setCookie(
      CSRF_COOKIE,
      result.csrfToken,
      this.buildCsrfCookieOptions(req, REMEMBER_ME_TTL_SECONDS),
    );

    return {
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
      user: result.user,
      memberships: result.memberships,
    };
  }

  // ── POST /auth/dev-login ─────────────────────────────────────────────────────
  // Passwordless sign-in for local development and E2E. The service hard-blocks
  // this in production (NODE_ENV==='production') so it is never a deployed
  // backdoor. Real environments use POST /auth/sso (Microsoft Entra ID).

  @Post('dev-login')
  @Public()
  @RateLimit('AUTH_LOGIN')
  @HttpCode(200)
  @ApiOperation({ summary: 'Passwordless dev/E2E login (non-production only)' })
  @ApiBody({ type: DevLoginDto })
  @ApiResponse({ status: 200, type: AuthTokenResponseDto })
  @ApiCommonErrors(400, 401, 422)
  async devLogin(
    @Body() dto: DevLoginDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthTokenResponseDto> {
    const result = await this.authService.devLogin(dto.email, req.ip);

    reply.setCookie(
      REFRESH_COOKIE,
      result.refreshToken,
      this.buildRefreshCookieOptions(req, REMEMBER_ME_TTL_SECONDS),
    );
    reply.setCookie(
      CSRF_COOKIE,
      result.csrfToken,
      this.buildCsrfCookieOptions(req, REMEMBER_ME_TTL_SECONDS),
    );

    return {
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
      user: result.user,
      memberships: result.memberships,
    };
  }

  // ── POST /auth/refresh ─────────────────────────────────────────────────────

  @Post('refresh')
  @Public()
  @RateLimit('AUTH_REFRESH')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rotate refresh token and issue new access token' })
  @ApiResponse({
    status: 200,
    schema: { properties: { accessToken: { type: 'string' }, expiresIn: { type: 'number' } } },
  })
  @ApiCommonErrors(401)
  async refresh(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Omit<AuthTokenResponseDto, 'user' | 'memberships'>> {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (!token) {
      throw new UnauthorizedException('AUTH_TOKEN_INVALID', 'Refresh token missing');
    }

    const csrfHeader = (req.headers['x-csrf-token'] as string | undefined) ?? null;

    const result = await this.authService.refresh(token, csrfHeader, req.ip);

    reply.setCookie(
      REFRESH_COOKIE,
      result.refreshToken,
      this.buildRefreshCookieOptions(req, REMEMBER_ME_TTL_SECONDS),
    );
    reply.setCookie(
      CSRF_COOKIE,
      result.csrfToken,
      this.buildCsrfCookieOptions(req, REMEMBER_ME_TTL_SECONDS),
    );

    return { accessToken: result.accessToken, expiresIn: result.expiresIn };
  }

  // ── POST /auth/switch-workspace ────────────────────────────────────────────

  @Post('switch-workspace')
  @Auth()
  @HttpCode(200)
  @RateLimit('AUTH_REFRESH')
  @ApiOperation({ summary: 'Switch active workspace and re-issue tokens' })
  @ApiBody({ type: SwitchWorkspaceDto })
  @ApiResponse({
    status: 200,
    schema: { properties: { accessToken: { type: 'string' }, expiresIn: { type: 'number' } } },
  })
  @ApiCommonErrors(401, 403)
  async switchWorkspace(
    @Body() dto: SwitchWorkspaceDto,
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Omit<AuthTokenResponseDto, 'user' | 'memberships'>> {
    const result = await this.authService.switchWorkspace(user, dto.workspaceId, req.ip);

    reply.setCookie(
      REFRESH_COOKIE,
      result.refreshToken,
      this.buildRefreshCookieOptions(req, REMEMBER_ME_TTL_SECONDS),
    );
    reply.setCookie(
      CSRF_COOKIE,
      result.csrfToken,
      this.buildCsrfCookieOptions(req, REMEMBER_ME_TTL_SECONDS),
    );

    return { accessToken: result.accessToken, expiresIn: result.expiresIn };
  }

  // ── POST /auth/logout ──────────────────────────────────────────────────────

  @Post('logout')
  @Auth()
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke current session and access token' })
  @ApiResponse({ status: 204, description: 'Session revoked' })
  @ApiCommonErrors(401)
  async logout(
    @CurrentUser() user: JwtPayload,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.authService.logout(user);
    reply.clearCookie(REFRESH_COOKIE, { path: COOKIE_BASE.path });
    reply.clearCookie(CSRF_COOKIE, { path: '/' });
  }

  // ── POST /auth/logout-all ──────────────────────────────────────────────────

  @Post('logout-all')
  @Auth()
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke all sessions for the authenticated user' })
  @ApiResponse({ status: 204, description: 'All sessions revoked' })
  @ApiCommonErrors(401)
  async logoutAll(
    @CurrentUser() user: JwtPayload,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.authService.logoutAll(user);
    reply.clearCookie(REFRESH_COOKIE, { path: COOKIE_BASE.path });
    reply.clearCookie(CSRF_COOKIE, { path: '/' });
  }

  // ── GET /auth/me ───────────────────────────────────────────────────────────

  @Get('me')
  @Auth()
  @ApiOperation({ summary: 'Get authenticated user profile' })
  @ApiResponse({ status: 200, type: UserProfileResponseDto })
  @ApiCommonErrors(401)
  async getMe(@CurrentUser() user: JwtPayload): Promise<UserProfileResponseDto> {
    const [profile, { role, permissions }, memberships] = await Promise.all([
      this.authService.getMe(user.sub),
      this.accessService.getUserRoleAndPermissions(user.sub, user.workspaceId),
      this.workspaceService.getMemberships(user.sub),
    ]);
    return {
      id: profile.id,
      email: profile.email,
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl,
      locale: profile.locale,
      timezone: profile.timezone,
      role,
      permissions,
      emailVerified: profile.emailVerified,
      createdAt: profile.createdAt.toISOString(),
      updatedAt: profile.updatedAt.toISOString(),
      memberships,
    };
  }

  // ── PATCH /auth/me ─────────────────────────────────────────────────────────

  @Patch('me')
  @Auth()
  @ApiOperation({ summary: 'Update authenticated user profile' })
  @ApiBody({ type: UpdateProfileDto })
  @ApiResponse({ status: 200, type: UserProfileResponseDto })
  @ApiCommonErrors(400, 401, 422)
  async updateProfile(
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateProfileDto,
  ): Promise<UserProfileResponseDto> {
    const [profile, { role, permissions }, memberships] = await Promise.all([
      this.authService.updateProfile(user.sub, dto),
      this.accessService.getUserRoleAndPermissions(user.sub, user.workspaceId),
      this.workspaceService.getMemberships(user.sub),
    ]);
    return {
      id: profile.id,
      email: profile.email,
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl,
      locale: profile.locale,
      timezone: profile.timezone,
      role,
      permissions,
      emailVerified: profile.emailVerified,
      createdAt: profile.createdAt.toISOString(),
      updatedAt: profile.updatedAt.toISOString(),
      memberships,
    };
  }
}

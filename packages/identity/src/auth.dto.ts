import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// ── Request DTOs ──────────────────────────────────────────────────────────────

/** Mutable profile fields a user may edit via `PATCH /auth/me`. */
export const UpdateProfileSchema = z.object({
  displayName: z.string().min(1).max(255).trim().optional(),
  avatarUrl: z.string().url().nullable().optional(),
  locale: z.string().min(2).max(10).optional(),
  timezone: z.string().min(1).max(100).optional(),
});

export class UpdateProfileDto extends createZodDto(UpdateProfileSchema) {}

export const SsoLoginSchema = z.object({
  /** Entra ID id_token obtained from MSAL handleRedirectPromise(). */
  idToken: z.string().min(1, 'idToken is required'),
});

export class SsoLoginDto extends createZodDto(SsoLoginSchema) {}

export const DevLoginSchema = z.object({
  /** Email of a seeded account. Passwordless — for local development and E2E only. */
  email: z.string().email('a valid email is required').max(320),
});

export class DevLoginDto extends createZodDto(DevLoginSchema) {}

export const SwitchWorkspaceSchema = z.object({
  workspaceId: z.string().uuid('workspaceId must be a valid UUID'),
});

export class SwitchWorkspaceDto extends createZodDto(SwitchWorkspaceSchema) {}

// ── Response DTOs ─────────────────────────────────────────────────────────────

const UserProfileSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  locale: z.string(),
  timezone: z.string(),
});

const WorkspaceMembershipSchema = z.object({
  workspaceId: z.string(),
  name: z.string(),
  slug: z.string(),
  lastActiveAt: z.string().nullable(),
  /** User's primary role slug in this workspace, e.g. 'workspace_admin'. */
  roleSlug: z.string().nullable(),
  /** Human-readable role label, e.g. 'Workspace Admin'. */
  roleName: z.string().nullable(),
});

export const AuthTokenResponseSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.number().describe('Seconds until access token expires'),
  user: UserProfileSchema,
  /**
   * All active workspace memberships, most-recently-active first. Drives the
   * workspace switcher. Omitted by single-tenant products (no workspaces).
   */
  memberships: z.array(WorkspaceMembershipSchema).optional(),
});

export class AuthTokenResponseDto extends createZodDto(AuthTokenResponseSchema) {}

export const UserProfileResponseSchema = UserProfileSchema.extend({
  role: z.string(),
  permissions: z.array(z.string()),
  emailVerified: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  /** All active workspace memberships, most-recently-active first. */
  memberships: z.array(WorkspaceMembershipSchema),
});

export class UserProfileResponseDto extends createZodDto(UserProfileResponseSchema) {}

/**
 * Domain-**service** ports for the identity bounded context — the collaborator
 * interfaces the shared `AuthService` depends on so it never imports a product's
 * concrete access-control, workspace-membership, or audit implementations.
 *
 * Behaviour-preserving port of the method surface rally's `AuthService` calls on
 * its `AccessService`, `WorkspaceService`, and `AuditService`. A product binds
 * its own services to these tokens, e.g.
 * `{ provide: ACCESS_SERVICE, useExisting: AccessService }`.
 */

/** A user's effective role slug plus flattened permission strings in a workspace. */
export interface RoleAndPermissions {
  role: string;
  permissions: string[];
}

/** Lifecycle state of a workspace membership. */
export type WorkspaceMemberStatus = 'active' | 'suspended' | 'removed';

/** Raw membership record for a user+workspace pair. */
export interface WorkspaceMember {
  id: string;
  workspaceId: string;
  userId: string;
  roleId: string | null;
  status: WorkspaceMemberStatus;
  lastActiveAt: Date | null;
  joinedAt: Date;
  updatedAt: Date;
  createdAt: Date;
}

/** Enriched membership used to resolve a user's active workspace at login. */
export interface WorkspaceMembership {
  workspaceId: string;
  name: string;
  slug: string;
  /** ISO-8601 string, or null if the user has never explicitly logged into this workspace. */
  lastActiveAt: string | null;
  /** The user's primary role slug in this workspace, e.g. 'workspace_admin'. Null when unassigned. */
  roleSlug: string | null;
  /** Human-readable role name, e.g. 'Workspace Admin'. */
  roleName: string | null;
}

/** Input shape for a single audit-log entry (the caller supplies the id). */
export interface CreateAuditLogInput {
  id: string;
  workspaceId: string;
  actorId?: string;
  actorEmail?: string;
  action: string;
  resourceType: string;
  resourceId: string;
  projectId?: string;
  changes?: { before?: unknown; after?: unknown };
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  /** Outbox eventId — used for at-most-once deduplication via ON CONFLICT DO NOTHING. */
  sourceEventId?: string;
}

/** What callers pass to {@link IAuditService.record} — id is generated internally. */
export type AuditRecordInput = Omit<CreateAuditLogInput, 'id'>;

/** DI token for {@link IAccessService}. */
export const ACCESS_SERVICE = Symbol('ACCESS_SERVICE');

/** Access-control queries the auth flow needs (roles, permissions, elevation). */
export interface IAccessService {
  /** Resolve the user's effective role slug and flattened permissions in a workspace. */
  getUserRoleAndPermissions(userId: string, workspaceId: string): Promise<RoleAndPermissions>;
  /** Grant the workspace_admin role to a user; returns false if the role is absent. */
  elevateToWorkspaceAdmin(userId: string, workspaceId: string): Promise<boolean>;
  /** Assign a default role to a user in a workspace, unless they already have one. */
  ensureDefaultRole(userId: string, workspaceId: string, defaultRoleSlug?: string): Promise<void>;
}

/** DI token for {@link IWorkspaceService}. */
export const WORKSPACE_SERVICE = Symbol('WORKSPACE_SERVICE');

/** Workspace-membership operations the auth flow needs at login / switch. */
export interface IWorkspaceService {
  /** List a user's memberships, most-recently-active first. */
  getMemberships(userId: string): Promise<WorkspaceMembership[]>;
  /** Return the membership record for a user+workspace pair, or null. */
  getMembership(userId: string, workspaceId: string): Promise<WorkspaceMember | null>;
  /** Stamp last_active_at on a user's membership. */
  touchMembership(userId: string, workspaceId: string): Promise<void>;
  /** Enroll a user as an active member of a workspace (idempotent). */
  enrollMember(workspaceId: string, userId: string, roleId?: string): Promise<void>;
}

/** DI token for {@link IAuditService}. */
export const AUDIT_SERVICE = Symbol('AUDIT_SERVICE');

/** Fire-and-forget audit sink — implementations must never throw back to the caller. */
export interface IAuditService {
  record(input: AuditRecordInput): Promise<void>;
}

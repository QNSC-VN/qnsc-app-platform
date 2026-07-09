/**
 * Global wildcard permission that grants every workspace-scoped action.
 * Kept as a constant so the semantics match the products' permission catalogs.
 */
export const WORKSPACE_ALL = 'workspace:*';

/** Predicate deciding whether a set of granted permissions satisfies a required one. */
export type PermissionChecker = (
  permissions: readonly string[] | undefined,
  required: string,
) => boolean;

/**
 * Default wildcard-aware permission check — one source of truth for the
 * semantics across every guard and service:
 *  - exact match, or
 *  - the global `workspace:*` grant, or
 *  - a namespace wildcard `ns:*` (e.g. `project:*` grants `project:update`).
 *
 * Products may override this by providing {@link PERMISSION_CHECKER}.
 */
export const permissionGrants: PermissionChecker = (permissions, required) => {
  if (!permissions?.length) return false;
  if (permissions.includes(WORKSPACE_ALL) || permissions.includes(required)) {
    return true;
  }
  const ns = required.split(':')[0];
  return !!ns && permissions.includes(`${ns}:*`);
};

/** Optional DI token to override the default {@link permissionGrants}. */
export const PERMISSION_CHECKER = Symbol('PERMISSION_CHECKER');

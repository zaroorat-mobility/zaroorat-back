export const AUTH_OTP_PURPOSE = 'LOGIN' as const;
export const IDEMPOTENCY_TTL_SECONDS = Number(process.env.IDEMPOTENCY_TTL_SECONDS ?? 86400);
/// Roles seeded as "provisioned out-of-band" (prisma/seed/shared/roles.ts) —
/// nobody should receive one of these just by logging in. `ensureDefaultRole`
/// grants DEFAULT_ROLE_SLUG to every login unconditionally, so a misconfigured
/// DEFAULT_USER_ROLE env var pointed at one of these would silently hand every
/// user staff-level access. Fail loudly at import time instead.
export const SYSTEM_ADMIN_ROLE_SLUG = 'system_admin' as const;
export const END_USER_ROLE_SLUGS = ['customer', 'driver'] as const;
export type EndUserRoleSlug = (typeof END_USER_ROLE_SLUGS)[number];
export const STAFF_ROLE_SLUGS = ['system_admin', 'admin', 'support', 'finance'] as const;
export type StaffRoleSlug = (typeof STAFF_ROLE_SLUGS)[number];
/// Seeded staff roles a system admin may assign. Custom roles (e.g. operations)
/// are also assignable once created via RBAC, as long as they are not end-user
/// or system_admin.
export const ASSIGNABLE_STAFF_ROLE_SLUGS = ['admin', 'support', 'finance'] as const;
export type AssignableStaffRoleSlug = (typeof ASSIGNABLE_STAFF_ROLE_SLUGS)[number];
export const LOCKED_PERMISSION_CODES = ['rbac:manage', 'staff:write'] as const;
export type LockedPermissionCode = (typeof LOCKED_PERMISSION_CODES)[number];

export function isEndUserRoleSlug(slug: string): boolean {
  return (END_USER_ROLE_SLUGS as readonly string[]).includes(slug);
}

export function isStaffRoleSlug(slug: string): boolean {
  return !isEndUserRoleSlug(slug);
}

export function isAssignableStaffRoleSlug(slug: string): boolean {
  return isStaffRoleSlug(slug) && slug !== SYSTEM_ADMIN_ROLE_SLUG;
}

const PRIVILEGED_ROLE_SLUGS = new Set<string>(STAFF_ROLE_SLUGS);
export const DEFAULT_ROLE_SLUG = process.env.DEFAULT_USER_ROLE ?? 'customer';
if (PRIVILEGED_ROLE_SLUGS.has(DEFAULT_ROLE_SLUG)) {
  throw new Error(
    `DEFAULT_USER_ROLE is set to "${DEFAULT_ROLE_SLUG}", a privileged role that must be ` +
      'provisioned out-of-band, not granted to every login. Refusing to start.',
  );
}

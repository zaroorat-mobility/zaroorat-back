import { ProviderClient } from '../../../src/core/database';

/**
 * Canonical RBAC roles (auth doc 03 §5). Seeded idempotently so every
 * environment is reproducible. `slug` is the stable identifier the app resolves
 * roles by; 'customer' is the platform-wide term (doc 03 §8 alignment).
 */
export const ROLE_SEED = [
  { slug: 'customer', name: 'Customer', description: 'Requests rides' },
  {
    slug: 'driver',
    name: 'Driver',
    description: 'Provides rides (operability gated by driver state)',
  },
  { slug: 'admin', name: 'Admin', description: 'Operations staff — provisioned out-of-band' },
  { slug: 'support', name: 'Support', description: 'Support staff — provisioned out-of-band' },
  {
    // Separation of duty: finance moves money out (payouts, refunds) but cannot
    // decide who may carry passengers. An admin can do both, which is why the
    // two are distinct roles rather than one "staff" role — the payout guard
    // named `finance` before this entry existed, so only admins ever passed it.
    slug: 'finance',
    name: 'Finance',
    description: 'Settlement and payout operations — provisioned out-of-band',
  },
] as const;

export type RoleSlug = (typeof ROLE_SEED)[number]['slug'];

/**
 * Capability vocabulary, in `resource:action` form.
 *
 * The codes reuse the scope names FILES already enforces in
 * `src/modules/files/policies/read-policy.ts` (`users:read`, `drivers:verify`,
 * `safety:read`, `support:read`) so the platform has **one** vocabulary rather
 * than a second, drifting copy.
 *
 * ## What these do and do not control today
 *
 * `app.authorize({ roles: [...] })` checks **role slugs**, not permission codes,
 * and `PermissionRepository` currently has no callers. So this table is the
 * declared capability map, not the live enforcement path.
 *
 * It is seeded anyway for two reasons: an empty `permissions` table makes
 * `findAllowedCodesForUser` return `[]` for everybody, which is a trap for the
 * first feature that reads it; and writing the role→capability mapping down is
 * what makes "should finance be able to verify drivers?" a reviewable question
 * instead of an assumption buried in a route file. Rewiring the guard to check
 * permission codes is a separate change and is deliberately not done here.
 */
export const PERMISSION_SEED = [
  { code: 'users:read', resource: 'users', action: 'read', description: 'Read any user profile' },
  {
    code: 'drivers:verify',
    resource: 'drivers',
    action: 'verify',
    description: 'Approve or reject driver verification, and read driver documents',
  },
  {
    code: 'drivers:suspend',
    resource: 'drivers',
    action: 'suspend',
    description: 'Suspend or reinstate a driver',
  },
  {
    code: 'safety:read',
    resource: 'safety',
    action: 'read',
    description: 'Read SOS and safety evidence',
  },
  {
    code: 'support:read',
    resource: 'support',
    action: 'read',
    description: 'Read dispute evidence and support material',
  },
  {
    code: 'rides:read_any',
    resource: 'rides',
    action: 'read_any',
    description: "Read any ride, not only one's own",
  },
  {
    code: 'payouts:execute',
    resource: 'payouts',
    action: 'execute',
    description: 'Execute a driver payout',
  },
  {
    code: 'refunds:process_any',
    resource: 'refunds',
    action: 'process_any',
    description: 'Refund a transaction belonging to another user',
  },
] as const;

export type PermissionCode = (typeof PERMISSION_SEED)[number]['code'];

/**
 * Role → capabilities.
 *
 * `customer` and `driver` appear with an empty list on purpose: they are
 * ordinary principals whose access is decided by **ownership**, not by a
 * capability grant. Listing them explicitly means a reader can tell "no
 * privileges" from "nobody thought about this role".
 */
export const ROLE_PERMISSIONS: Readonly<Record<RoleSlug, readonly PermissionCode[]>> =
  Object.freeze({
    customer: Object.freeze([] as const),
    driver: Object.freeze([] as const),
    admin: Object.freeze([
      'users:read',
      'drivers:verify',
      'drivers:suspend',
      'safety:read',
      'support:read',
      'rides:read_any',
      'payouts:execute',
      'refunds:process_any',
    ] as const),
    support: Object.freeze(['support:read', 'safety:read', 'rides:read_any'] as const),
    // Deliberately NOT drivers:verify or drivers:suspend — finance moves money,
    // it does not decide operability.
    finance: Object.freeze(['payouts:execute', 'refunds:process_any', 'rides:read_any'] as const),
  });

/**
 * Seed roles, permissions, and their mapping.
 *
 * Idempotent throughout: `upsert` on the natural keys (`slug`, `code`) and on
 * the `(roleId, permissionId)` unique pair, so re-running converges rather than
 * duplicating. Permissions a role should no longer hold are **revoked**, so the
 * database matches {@link ROLE_PERMISSIONS} rather than accumulating whatever
 * any past version granted — a seed that only ever adds cannot take a
 * capability away.
 */
export async function seedRoles(prisma: ProviderClient): Promise<void> {
  for (const role of ROLE_SEED) {
    await prisma.role.upsert({
      where: { slug: role.slug },
      update: { name: role.name, description: role.description },
      create: { slug: role.slug, name: role.name, description: role.description, isSystem: true },
    });
  }

  for (const permission of PERMISSION_SEED) {
    await prisma.permission.upsert({
      where: { code: permission.code },
      update: {
        resource: permission.resource,
        action: permission.action,
        description: permission.description,
      },
      create: {
        code: permission.code,
        resource: permission.resource,
        action: permission.action,
        description: permission.description,
      },
    });
  }

  const roles = await prisma.role.findMany({ select: { id: true, slug: true } });
  const permissions = await prisma.permission.findMany({ select: { id: true, code: true } });
  const permissionIdByCode = new Map(permissions.map((p) => [p.code, p.id]));

  for (const role of roles) {
    const intended = ROLE_PERMISSIONS[role.slug as RoleSlug];
    // A role in the database that this seed does not describe is left untouched:
    // it may have been created deliberately out-of-band, and silently stripping
    // its grants would be worse than leaving it alone.
    if (!intended) continue;

    const intendedIds = new Set(
      intended.map((code) => permissionIdByCode.get(code)).filter((id): id is string => !!id),
    );

    for (const permissionId of intendedIds) {
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId } },
        update: { effect: 'ALLOW' },
        create: { roleId: role.id, permissionId, effect: 'ALLOW' },
      });
    }

    // Converge: drop grants this role should no longer have.
    await prisma.rolePermission.deleteMany({
      where: { roleId: role.id, permissionId: { notIn: [...intendedIds] } },
    });
  }
}

/**
 * Grants a role to a user idempotently. Because active-uniqueness is a partial
 * index (not a Prisma unique), we look for a live assignment before creating one.
 */
export async function assignRole(
  prisma: ProviderClient,
  userId: string,
  slug: RoleSlug,
): Promise<void> {
  const role = await prisma.role.findUniqueOrThrow({ where: { slug } });

  const existing = await prisma.userRoleAssignment.findFirst({
    where: { userId, roleId: role.id, revokedAt: null },
  });

  if (!existing) {
    await prisma.userRoleAssignment.create({ data: { userId, roleId: role.id } });
  }
}

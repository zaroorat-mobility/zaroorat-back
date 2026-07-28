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
] as const;

export type RoleSlug = (typeof ROLE_SEED)[number]['slug'];

export async function seedRoles(prisma: ProviderClient): Promise<void> {
  for (const role of ROLE_SEED) {
    await prisma.role.upsert({
      where: { slug: role.slug },
      update: { name: role.name, description: role.description },
      create: { slug: role.slug, name: role.name, description: role.description, isSystem: true },
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

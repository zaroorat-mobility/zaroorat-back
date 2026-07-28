import { ProviderClient } from '../../../src/core/database';
import { assignRole, RoleSlug, seedRoles } from '../shared/roles';

type Prisma = ProviderClient;

/**
 * Idempotently ensure a verified user with a profile exists for `phone`.
 * Phone uniqueness is a PARTIAL index (doc 03 §4), so there is no Prisma-level
 * unique to drive upsert — we resolve the live row first, then create.
 */
async function ensureUser(
  prisma: Prisma,
  phone: string,
  profile: { firstName: string; lastName: string },
  extra?: Record<string, unknown>,
) {
  const existing = await prisma.user.findFirst({ where: { phoneNumber: phone, deletedAt: null } });
  if (existing) return existing;

  return prisma.user.create({
    data: {
      phoneNumber: phone,
      status: 'ACTIVE',
      isPhoneVerified: true,
      profile: { create: profile },
      ...extra,
    },
  });
}

export async function seedDevelopment(prisma: Prisma) {
  console.log('  -> Seeding dev-only mock data...');

  // Roles are reference data; ensure they exist before assigning them.
  await seedRoles(prisma);

  const fixtures: Array<{
    phone: string;
    profile: { firstName: string; lastName: string };
    roles: RoleSlug[];
    extra?: Record<string, unknown>;
  }> = [
    { phone: '+10000000000', profile: { firstName: 'Admin', lastName: 'User' }, roles: ['admin'] },
    {
      phone: '+10000000001',
      profile: { firstName: 'Demo', lastName: 'Driver' },
      roles: ['customer', 'driver'],
      extra: {
        driver: {
          create: {
            driverCode: 'DRV0001',
            verificationStatus: 'VERIFIED',
          },
        },
      },
    },
    {
      phone: '+10000000002',
      profile: { firstName: 'Demo', lastName: 'Passenger' },
      roles: ['customer'],
    },
  ];

  for (const fixture of fixtures) {
    const user = await ensureUser(prisma, fixture.phone, fixture.profile, fixture.extra);
    for (const slug of fixture.roles) {
      await assignRole(prisma, user.id, slug);
    }
  }
}

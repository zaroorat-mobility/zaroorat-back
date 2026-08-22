import { ProviderClient } from '../../../src/core/database';
import { seedRoles } from '../shared/roles';
import { seedVehicleTypes } from '../shared/vehicle-types';

export async function seedTesting(prisma: ProviderClient) {
  console.log('  -> Seeding testing data...');
  // The four canonical RBAC roles are the minimum the auth test suite depends on
  // (doc 07 §2): role grants during login resolve `customer` by slug.
  await seedRoles(prisma);
  // The service catalog — reference data, same as roles: every environment
  // needs it, and no client can obtain a vehicleTypeId without it.
  await seedVehicleTypes(prisma);
}

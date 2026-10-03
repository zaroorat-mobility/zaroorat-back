import { ProviderClient } from '../../../src/core/database';
import { seedRoles } from '../shared/roles';
import { seedVehicleTypes } from '../shared/vehicle-types';
import { seedAppConfig } from '../shared/app-config';
import { seedGeographicReference } from '../shared/geography';

export async function seedProduction(prisma: ProviderClient) {
  console.log('  -> Seeding production data...');

  // Canonical RBAC roles are essential reference data — required in every
  // environment, safe to run repeatedly (auth doc 03 §5). NEVER add mock data here.
  await seedRoles(prisma);
  // The service catalog — reference data, same as roles: every environment
  // needs it, and no client can obtain a vehicleTypeId without it.
  await seedVehicleTypes(prisma);
  // Canonical Geographic reference data (India 28 States + 8 UTs with LGD codes).
  await seedGeographicReference(prisma);
  // App themes / fonts / locales / translations — reference data for clients.
  await seedAppConfig(prisma);
}

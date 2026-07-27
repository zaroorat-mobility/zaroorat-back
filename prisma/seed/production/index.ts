import { ProviderClient } from '../../../src/core/database';
import { seedRoles } from '../shared/roles';

export async function seedProduction(prisma: ProviderClient) {
  console.log('  -> Seeding production data...');

  // Canonical RBAC roles are essential reference data — required in every
  // environment, safe to run repeatedly (auth doc 03 §5). NEVER add mock data here.
  await seedRoles(prisma);
}

import { ProviderClient } from '../../../src/core/database';

export async function seedTesting(_prisma: ProviderClient) {
  console.log('  -> Seeding testing data...');
  // Add minimal deterministic data required for unit/integration tests
  // E.g. Default settings, standard user, test car category
}

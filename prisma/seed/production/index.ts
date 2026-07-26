import { ProviderClient } from '../../../src/core/database';

// Prefixed with _ until the body is implemented; the eslint config treats a
// leading underscore as "intentionally unused".
export async function seedProduction(_prisma: ProviderClient) {
  console.log('  -> Seeding production data...');
  // Only add essential system settings, roles, or vehicle categories
  // NEVER INSERT MOCK DATA HERE
}

import { PrismaClient } from '@prisma/client';

// Prefixed with _ until the body is implemented; the eslint config treats a
// leading underscore as "intentionally unused".
export async function seedProduction(_prisma: PrismaClient) {
  console.log('  -> Seeding production data...');
  // Only add essential system settings, roles, or vehicle categories
  // NEVER INSERT MOCK DATA HERE
}

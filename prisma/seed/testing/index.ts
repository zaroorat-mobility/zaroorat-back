import { PrismaClient } from '@prisma/client';

export async function seedTesting(_prisma: PrismaClient) {
  console.log('  -> Seeding testing data...');
  // Add minimal deterministic data required for unit/integration tests
  // E.g. Default settings, standard user, test car category
}

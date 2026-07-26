import { PrismaClient } from '../../../generated/prisma';

export function createPricingExtensions(prisma: PrismaClient) {
  return prisma.$extends({
    // Add custom pricing queries here
  });
}

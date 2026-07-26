import { PrismaClient } from '../../../generated/prisma';

export function createDriverExtensions(prisma: PrismaClient) {
  return prisma.$extends({
    model: {
      driver: {
        async findActiveDrivers() {
          return prisma.driver.findMany({ where: { verificationStatus: 'VERIFIED' } });
        },
      },
    },
  });
}

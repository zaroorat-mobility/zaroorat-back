import { PrismaClient } from '../../../generated/prisma';

export function createRideExtensions(prisma: PrismaClient) {
  return prisma.$extends({
    model: {
      ride: {
        async findActiveRides() {
          return prisma.ride.findMany({ where: { status: 'IN_PROGRESS' } });
        },
      },
    },
  });
}

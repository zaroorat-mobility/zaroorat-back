import { Prisma } from '../../../generated/prisma';

export const rideExtension = Prisma.defineExtension({
  name: 'RideExtension',
  model: {
    ride: {
      async findActiveRides() {
        const ctx = Prisma.getExtensionContext(this);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (ctx as any).findMany({ where: { status: 'IN_PROGRESS' } });
      },
    },
  },
});

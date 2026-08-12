/* eslint-disable @typescript-eslint/no-explicit-any */
import { Prisma } from '../../../generated/prisma';

export const rideExtension = Prisma.defineExtension({
  name: 'RideExtension',
  model: {
    ride: {
      async findActiveRides() {
        const ctx = Prisma.getExtensionContext(this);

        return (ctx as any).findMany({ where: { status: 'IN_PROGRESS' } });
      },
    },
  },
});

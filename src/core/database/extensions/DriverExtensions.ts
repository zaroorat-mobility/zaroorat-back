/* eslint-disable @typescript-eslint/no-explicit-any */
import { Prisma } from '../../../generated/prisma';

export const driverExtension = Prisma.defineExtension({
  name: 'DriverExtension',
  model: {
    driver: {
      async findActiveDrivers() {
        const ctx = Prisma.getExtensionContext(this);

        return (ctx as any).findMany({ where: { verificationStatus: 'VERIFIED' } });
      },
    },
  },
});

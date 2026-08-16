import { Prisma } from '../../../generated/prisma';
export const driverExtension = Prisma.defineExtension({
  name: 'DriverExtension',
  model: {
    driver: {
      async findActiveDrivers() {
        const ctx = Prisma.getExtensionContext(this);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (ctx as any).findMany({ where: { verificationStatus: 'VERIFIED' } });
      },
    },
  },
});

import { Prisma } from '../../../generated/prisma';

export const paymentExtension = Prisma.defineExtension({
  name: 'PaymentExtension',
  model: {
    paymentTransaction: {
      async findPendingPayments() {
        const ctx = Prisma.getExtensionContext(this);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (ctx as any).findMany({ where: { status: 'PENDING' } });
      },
    },
  },
});

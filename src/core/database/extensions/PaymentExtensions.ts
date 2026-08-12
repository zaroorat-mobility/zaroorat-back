/* eslint-disable @typescript-eslint/no-explicit-any */
import { Prisma } from '../../../generated/prisma';

export const paymentExtension = Prisma.defineExtension({
  name: 'PaymentExtension',
  model: {
    paymentTransaction: {
      async findPendingPayments() {
        const ctx = Prisma.getExtensionContext(this);

        return (ctx as any).findMany({ where: { status: 'PENDING' } });
      },
    },
  },
});

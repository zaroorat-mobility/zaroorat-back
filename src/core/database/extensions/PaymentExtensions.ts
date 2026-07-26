import { PrismaClient } from '../../../generated/prisma';

export function createPaymentExtensions(prisma: PrismaClient) {
  return prisma.$extends({
    model: {
      paymentTransaction: {
        async findPendingPayments() {
          return prisma.paymentTransaction.findMany({ where: { status: 'PENDING' } });
        },
      },
    },
  });
}

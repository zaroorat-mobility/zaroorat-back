import { PrismaClient } from '../../../generated/prisma';

export function createUserExtensions(prisma: PrismaClient) {
  return prisma.$extends({
    model: {
      user: {
        async findByPhone(phone: string) {
          return prisma.user.findUnique({ where: { phoneNumber: phone } });
        },
      },
    },
  });
}

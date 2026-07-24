import prisma from './client';

// Example of extending the Prisma client with computed fields or custom methods
// This allows you to encapsulate domain logic directly on the models

export const extendedPrisma = prisma.$extends({
  model: {
    user: {
      async findByPhone(phone: string) {
        return prisma.user.findUnique({ where: { phoneNumber: phone } });
      },
    },
  },
});

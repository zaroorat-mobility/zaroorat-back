/* eslint-disable @typescript-eslint/no-explicit-any */
import { Prisma } from '../../../generated/prisma';

export const userExtension = Prisma.defineExtension({
  name: 'UserExtension',
  model: {
    user: {
      async findByPhone(phone: string) {
        const ctx = Prisma.getExtensionContext(this);

        return (ctx as any).findFirst({ where: { phoneNumber: phone, deletedAt: null } });
      },
    },
  },
});

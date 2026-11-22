import { Prisma } from '../../../generated/prisma';
export const userExtension = Prisma.defineExtension({
  name: 'UserExtension',
  model: {
    user: {
      async findByPhone(phone: string) {
        const ctx = Prisma.getExtensionContext(this);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (ctx as any).findFirst({ where: { phoneNumber: phone, deletedAt: null } });
      },
    },
  },
});

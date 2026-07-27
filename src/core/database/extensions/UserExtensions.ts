import { Prisma } from '../../../generated/prisma';

export const userExtension = Prisma.defineExtension({
  name: 'UserExtension',
  model: {
    user: {
      async findByPhone(phone: string) {
        const ctx = Prisma.getExtensionContext(this);
        // Phone uniqueness is PARTIAL (active rows only, doc 03 §4), so there is
        // no Prisma-level unique to drive findUnique — resolve the live account.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (ctx as any).findFirst({ where: { phoneNumber: phone, deletedAt: null } });
      },
    },
  },
});

import { PrismaClient, UserRole } from '../../../src/generated/prisma';

export async function seedDevelopment(prisma: PrismaClient) {
  console.log('  -> Seeding dev-only mock data...');

  // Create an Admin
  await prisma.user.upsert({
    where: { phoneNumber: '+10000000000' },
    update: {},
    create: {
      phoneNumber: '+10000000000',
      role: UserRole.ADMIN,
      isPhoneVerified: true,
      profile: {
        create: { firstName: 'Admin', lastName: 'User' },
      },
    },
  });

  // Create a Driver
  await prisma.user.upsert({
    where: { phoneNumber: '+10000000001' },
    update: {},
    create: {
      phoneNumber: '+10000000001',
      role: UserRole.DRIVER,
      isPhoneVerified: true,
      profile: {
        create: { firstName: 'Demo', lastName: 'Driver' },
      },
      driver: {
        create: {
          driverCode: 'DRV0001',
          onboardingStatus: 'VERIFIED',
          verificationStatus: 'VERIFIED',
        },
      },
    },
  });

  // Create a Customer (Rider)
  await prisma.user.upsert({
    where: { phoneNumber: '+10000000002' },
    update: {},
    create: {
      phoneNumber: '+10000000002',
      role: UserRole.CUSTOMER,
      isPhoneVerified: true,
      profile: {
        create: { firstName: 'Demo', lastName: 'Passenger' },
      },
    },
  });
}

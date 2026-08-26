import { ProviderClient } from '../../../src/core/database';
import { hashPassword } from '../../../src/modules/auth/utils/password';
import { driverConfig } from '../../../src/config/driver/driver.config';
import { vehicleConfig } from '../../../src/config/vehicle/vehicle.config';
import { assignRole, RoleSlug, seedRoles } from '../shared/roles';
import { seedVehicleTypes } from '../shared/vehicle-types';

type Prisma = ProviderClient;

/**
 * Idempotently ensure a verified user with a profile exists for `phone`.
 * Phone uniqueness is a PARTIAL index (doc 03 §4), so there is no Prisma-level
 * unique to drive upsert — we resolve the live row first, then create.
 */
async function ensureUser(
  prisma: Prisma,
  phone: string,
  profile: { firstName: string; lastName: string },
  extra?: Record<string, unknown>,
) {
  const existing = await prisma.user.findFirst({ where: { phoneNumber: phone, deletedAt: null } });
  if (existing) {
    if (extra && extra.email != null) {
      return prisma.user.update({
        where: { id: existing.id },
        data: {
          email: extra.email as string,
          passwordHash: extra.passwordHash as string,
          isEmailVerified: extra.isEmailVerified === true,
        },
      });
    }
    return existing;
  }

  return prisma.user.create({
    data: {
      phoneNumber: phone,
      status: 'ACTIVE',
      isPhoneVerified: true,
      profile: { create: profile },
      ...extra,
    },
  });
}

async function ensureDriver(
  prisma: Prisma,
  userId: string,
  input: {
    driverCode: string;
    verificationStatus: 'PENDING' | 'DOCUMENT_REVIEW' | 'VERIFIED' | 'REJECTED';
    fullLegalName: string;
    city?: string;
    state?: string;
  },
) {
  const existing = await prisma.driver.findUnique({ where: { userId } });
  if (existing) {
    const updated = await prisma.driver.update({
      where: { id: existing.id },
      data: {
        driverCode: input.driverCode,
        verificationStatus: input.verificationStatus,
        ...(input.verificationStatus === 'VERIFIED'
          ? { approvedAt: existing.approvedAt ?? new Date() }
          : {}),
      },
    });
    await prisma.driverProfile.upsert({
      where: { driverId: updated.id },
      create: {
        driverId: updated.id,
        fullLegalName: input.fullLegalName,
        city: input.city ?? 'Srinagar',
        state: input.state ?? 'Jammu & Kashmir',
        country: 'India',
      },
      update: {
        fullLegalName: input.fullLegalName,
        city: input.city ?? 'Srinagar',
        state: input.state ?? 'Jammu & Kashmir',
      },
    });
    await prisma.driverWallet.upsert({
      where: { driverId: updated.id },
      create: { driverId: updated.id, balance: 1250, lockedBalance: 0 },
      update: {},
    });
    return updated;
  }

  const driver = await prisma.driver.create({
    data: {
      userId,
      driverCode: input.driverCode,
      verificationStatus: input.verificationStatus,
      ...(input.verificationStatus === 'VERIFIED' ? { approvedAt: new Date() } : {}),
      profile: {
        create: {
          fullLegalName: input.fullLegalName,
          city: input.city ?? 'Srinagar',
          state: input.state ?? 'Jammu & Kashmir',
          country: 'India',
        },
      },
      wallet: {
        create: { balance: input.verificationStatus === 'VERIFIED' ? 1250 : 0, lockedBalance: 0 },
      },
    },
  });
  return driver;
}

async function ensureDriverDocuments(
  prisma: Prisma,
  driverId: string,
  status: 'PENDING' | 'VERIFIED' | 'REJECTED',
) {
  for (const documentType of driverConfig.requiredDocumentTypes) {
    const existing = await prisma.driverDocument.findUnique({
      where: { driverId_documentType: { driverId, documentType } },
    });
    if (existing) {
      await prisma.driverDocument.update({
        where: { id: existing.id },
        data: {
          verificationStatus: status,
          fileUrl: existing.fileUrl ?? `https://example.invalid/${documentType.toLowerCase()}.jpg`,
          documentNumber: existing.documentNumber ?? `${documentType}-SEED-${driverId.slice(0, 6)}`,
          ...(status === 'VERIFIED'
            ? { verifiedAt: existing.verifiedAt ?? new Date() }
            : { verifiedAt: null }),
        },
      });
      continue;
    }
    await prisma.driverDocument.create({
      data: {
        driverId,
        documentType,
        verificationStatus: status,
        fileUrl: `https://example.invalid/${documentType.toLowerCase()}.jpg`,
        documentNumber: `${documentType}-SEED-${driverId.slice(0, 6)}`,
        ...(status === 'VERIFIED' ? { verifiedAt: new Date() } : {}),
        ...(documentType === 'DRIVING_LICENSE' || documentType === 'INSURANCE'
          ? { expiresAt: new Date('2030-12-31') }
          : {}),
      },
    });
  }
}

async function ensureAssignedVehicle(
  prisma: Prisma,
  driverId: string,
  input: {
    registrationNumber: string;
    verified: boolean;
    make?: string;
    model?: string;
    color?: string;
  },
) {
  const vehicleType = await prisma.vehicleType.findUniqueOrThrow({
    where: { code: 'CAB_ECONOMY' },
  });
  let vehicle = await prisma.vehicle.findUnique({
    where: { registrationNumber: input.registrationNumber },
  });

  if (!vehicle) {
    vehicle = await prisma.vehicle.create({
      data: {
        registrationNumber: input.registrationNumber,
        vehicleTypeId: vehicleType.id,
        make: input.make ?? 'Maruti Suzuki',
        model: input.model ?? 'Swift Dzire',
        color: input.color ?? 'White',
        seatingCapacity: 4,
        manufacturingYear: 2022,
        currentDriverId: driverId,
        isActive: true,
        verificationStatus: input.verified ? 'VERIFIED' : 'PENDING',
        ...(input.verified ? { verifiedAt: new Date() } : {}),
      },
    });
  } else {
    vehicle = await prisma.vehicle.update({
      where: { id: vehicle.id },
      data: {
        vehicleTypeId: vehicleType.id,
        make: input.make ?? vehicle.make,
        model: input.model ?? vehicle.model,
        color: input.color ?? vehicle.color,
        currentDriverId: driverId,
        isActive: true,
        verificationStatus: input.verified ? 'VERIFIED' : 'PENDING',
        verifiedAt: input.verified ? (vehicle.verifiedAt ?? new Date()) : null,
      },
    });
  }

  const docTypes = [
    ...new Set([...vehicleConfig.requiredDocumentTypes, 'PERMIT', 'PUC', 'FITNESS']),
  ];
  for (const documentType of docTypes) {
    const existing = await prisma.vehicleDocument.findUnique({
      where: {
        vehicleId_documentType: { vehicleId: vehicle.id, documentType },
      },
    });
    const expiry = new Date('2028-06-30');
    if (existing) {
      await prisma.vehicleDocument.update({
        where: { id: existing.id },
        data: {
          verificationStatus: input.verified ? 'VERIFIED' : 'PENDING',
          documentNumber: existing.documentNumber ?? `${documentType}-${input.registrationNumber}`,
          fileUrl:
            existing.fileUrl ?? `https://example.invalid/vehicle-${documentType.toLowerCase()}.jpg`,
          expiresAt: existing.expiresAt ?? expiry,
          ...(input.verified
            ? { verifiedAt: existing.verifiedAt ?? new Date() }
            : { verifiedAt: null }),
        },
      });
    } else {
      await prisma.vehicleDocument.create({
        data: {
          vehicleId: vehicle.id,
          documentType,
          verificationStatus: input.verified ? 'VERIFIED' : 'PENDING',
          documentNumber: `${documentType}-${input.registrationNumber}`,
          fileUrl: `https://example.invalid/vehicle-${documentType.toLowerCase()}.jpg`,
          expiresAt: expiry,
          ...(input.verified ? { verifiedAt: new Date() } : {}),
        },
      });
    }
  }

  const assignment = await prisma.vehicleAssignment.findFirst({
    where: { driverId, vehicleId: vehicle.id, status: 'ACTIVE', releasedAt: null },
  });
  if (!assignment) {
    await prisma.vehicleAssignment.create({
      data: { driverId, vehicleId: vehicle.id, status: 'ACTIVE' },
    });
  }

  await prisma.driver.update({
    where: { id: driverId },
    data: { currentVehicleId: vehicle.id },
  });

  return vehicle;
}

export async function seedDevelopment(prisma: Prisma) {
  console.log('  -> Seeding dev-only mock data...');

  // Roles are reference data; ensure they exist before assigning them.
  await seedRoles(prisma);
  // The service catalog — reference data, same as roles: every environment
  // needs it, and no client can obtain a vehicleTypeId without it.
  await seedVehicleTypes(prisma);

  const fixtures: Array<{
    phone: string;
    profile: { firstName: string; lastName: string };
    roles: RoleSlug[];
    extra?: Record<string, unknown>;
  }> = [
    {
      phone: '+10000000000',
      profile: { firstName: 'Admin', lastName: 'User' },
      roles: ['system_admin'],
      extra: {
        email: (process.env.ADMIN_SEED_EMAIL ?? 'admin@zaroorat.com').toLowerCase(),
        passwordHash: hashPassword(process.env.ADMIN_SEED_PASSWORD ?? 'Admin@12345'),
        isEmailVerified: true,
      },
    },
    {
      phone: '+10000000001',
      profile: { firstName: 'Demo', lastName: 'Driver' },
      roles: ['customer', 'driver'],
    },
    {
      phone: '+10000000002',
      profile: { firstName: 'Demo', lastName: 'Passenger' },
      roles: ['customer'],
    },
    {
      phone: '+10000000003',
      profile: { firstName: 'Pending', lastName: 'Applicant' },
      roles: ['customer', 'driver'],
    },
  ];

  for (const fixture of fixtures) {
    const user = await ensureUser(prisma, fixture.phone, fixture.profile, fixture.extra);
    for (const slug of fixture.roles) {
      await assignRole(prisma, user.id, slug);
    }
  }

  // Verified operable partner — appears in Drivers Directory + Vehicles Directory.
  const verifiedUser = await prisma.user.findFirstOrThrow({
    where: { phoneNumber: '+10000000001', deletedAt: null },
  });
  const verifiedDriver = await ensureDriver(prisma, verifiedUser.id, {
    driverCode: 'DRV0001',
    verificationStatus: 'VERIFIED',
    fullLegalName: 'Demo Driver',
  });
  await ensureDriverDocuments(prisma, verifiedDriver.id, 'VERIFIED');
  await ensureAssignedVehicle(prisma, verifiedDriver.id, {
    registrationNumber: 'JK01AB1234',
    verified: true,
    make: 'Maruti Suzuki',
    model: 'Swift Dzire',
    color: 'White',
  });

  // Pending application — appears in Driver Applications for verify workflow.
  const pendingUser = await prisma.user.findFirstOrThrow({
    where: { phoneNumber: '+10000000003', deletedAt: null },
  });
  const pendingDriver = await ensureDriver(prisma, pendingUser.id, {
    driverCode: 'DRV0002',
    verificationStatus: 'PENDING',
    fullLegalName: 'Pending Applicant',
    city: 'Jammu',
  });
  await ensureDriverDocuments(prisma, pendingDriver.id, 'PENDING');
  await ensureAssignedVehicle(prisma, pendingDriver.id, {
    registrationNumber: 'JK02CD5678',
    verified: false,
    make: 'Bajaj',
    model: 'RE Auto',
    color: 'Yellow',
  });

  console.log(
    '  -> Seeded verified driver DRV0001 + pending application DRV0002 with linked vehicles',
  );
}

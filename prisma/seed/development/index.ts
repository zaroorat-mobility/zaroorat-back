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

  await seedCities(prisma);
  await seedPricingFixtures(prisma);
  console.log('  -> Seeded GLOBAL fare rules, Srinagar surge zone/windows, cancellation policies');

  await seedPromotionsFixtures(prisma);
  await seedReferralFixtures(prisma);
}

async function seedCities(prisma: Prisma) {
  const cities = [
    { code: 'SGR', name: 'Srinagar', state: 'Jammu & Kashmir' },
    { code: 'BLR', name: 'Bengaluru', state: 'Karnataka' },
    { code: 'GLOBAL', name: 'All cities (global)', state: null as string | null },
  ];
  for (const city of cities) {
    await prisma.city.upsert({
      where: { code: city.code },
      update: { name: city.name, state: city.state, isActive: true },
      create: {
        code: city.code,
        name: city.name,
        state: city.state,
        country: 'India',
        isActive: true,
        launchedAt: new Date(),
      },
    });
  }
  console.log('  -> Seeded cities SGR, BLR, GLOBAL');
}

async function seedPricingFixtures(prisma: Prisma) {
  const types = await prisma.vehicleType.findMany();
  const byCode = Object.fromEntries(types.map((t) => [t.code, t]));

  const fareSeeds: Array<{
    code: string;
    baseFare: number;
    minimumFare: number;
    perKmRate: number;
    perMinuteRate: number;
    freeWaitingMin: number;
    waitingPerMin: number;
    nightMultiplier: number;
  }> = [
    {
      code: 'CAB_ECONOMY',
      baseFare: 60,
      minimumFare: 80,
      perKmRate: 15,
      perMinuteRate: 1.5,
      freeWaitingMin: 5,
      waitingPerMin: 3,
      nightMultiplier: 1.25,
    },
    {
      code: 'AUTO',
      baseFare: 30,
      minimumFare: 40,
      perKmRate: 10,
      perMinuteRate: 1,
      freeWaitingMin: 3,
      waitingPerMin: 2,
      nightMultiplier: 1.2,
    },
    {
      code: 'BIKE',
      baseFare: 20,
      minimumFare: 25,
      perKmRate: 7,
      perMinuteRate: 0.8,
      freeWaitingMin: 2,
      waitingPerMin: 1.5,
      nightMultiplier: 1.15,
    },
  ];

  for (const seed of fareSeeds) {
    const vt = byCode[seed.code];
    if (!vt) continue;
    const existing = await prisma.pricingRule.findFirst({
      where: { vehicleTypeId: vt.id, cityCode: 'GLOBAL', isActive: true },
    });
    if (existing) continue;
    await prisma.pricingRule.create({
      data: {
        vehicleTypeId: vt.id,
        cityCode: 'GLOBAL',
        baseFare: seed.baseFare,
        minimumFare: seed.minimumFare,
        perKmRate: seed.perKmRate,
        perMinuteRate: seed.perMinuteRate,
        freeWaitingMin: seed.freeWaitingMin,
        waitingPerMin: seed.waitingPerMin,
        nightMultiplier: seed.nightMultiplier,
        isActive: true,
        version: 1,
      },
    });
  }

  // City-wide Srinagar polygon (approx bounding box as closed ring [lng, lat]).
  const existingZones = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM surge_zones WHERE city_code = 'SGR' AND name = 'Srinagar Citywide' LIMIT 1
  `;
  let zoneId = existingZones[0]?.id;
  if (!zoneId) {
    const geoJson = JSON.stringify({
      type: 'Polygon',
      coordinates: [
        [
          [74.7, 34.0],
          [75.0, 34.0],
          [75.0, 34.2],
          [74.7, 34.2],
          [74.7, 34.0],
        ],
      ],
    });
    const created = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO surge_zones (id, city_code, name, boundary, is_active, created_at)
      VALUES (
        gen_random_uuid(),
        'SGR',
        'Srinagar Citywide',
        ST_GeomFromGeoJSON(${geoJson}),
        true,
        NOW()
      )
      RETURNING id
    `;
    zoneId = created[0]?.id;
  }

  if (zoneId) {
    const cab = byCode['CAB_ECONOMY'];
    const auto = byCode['AUTO'];
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(8, 0, 0, 0);
    const tomorrowEnd = new Date(tomorrow);
    tomorrowEnd.setUTCHours(11, 0, 0, 0);
    const evening = new Date();
    evening.setUTCDate(evening.getUTCDate() + 1);
    evening.setUTCHours(17, 0, 0, 0);
    const eveningEnd = new Date(evening);
    eveningEnd.setUTCHours(20, 0, 0, 0);

    const windowCount = await prisma.surgeWindow.count({ where: { zoneId } });
    if (windowCount === 0) {
      if (cab) {
        await prisma.surgeWindow.create({
          data: {
            zoneId,
            vehicleTypeId: cab.id,
            multiplier: 1.5,
            startsAt: tomorrow,
            endsAt: tomorrowEnd,
            reason: 'Morning Peak Cab Surge',
            source: 'MANUAL',
            isActive: true,
          },
        });
      }
      if (auto) {
        await prisma.surgeWindow.create({
          data: {
            zoneId,
            vehicleTypeId: auto.id,
            multiplier: 1.2,
            startsAt: evening,
            endsAt: eveningEnd,
            reason: 'Evening Peak Auto Surge',
            source: 'MANUAL',
            isActive: true,
          },
        });
      }
    }
  }

  const cancelSeeds: Array<{
    cancelledBy: string;
    minStatus: string;
    feeAmount: number;
  }> = [
    { cancelledBy: 'RIDER', minStatus: 'AFTER_ASSIGNMENT', feeAmount: 20 },
    { cancelledBy: 'RIDER', minStatus: 'AFTER_ARRIVAL', feeAmount: 40 },
    { cancelledBy: 'DRIVER', minStatus: 'AFTER_ASSIGNMENT', feeAmount: 30 },
    { cancelledBy: 'RIDER', minStatus: 'NO_SHOW', feeAmount: 50 },
  ];

  for (const seed of cancelSeeds) {
    const existing = await prisma.cancellationPolicy.findFirst({
      where: {
        cancelledBy: seed.cancelledBy,
        minStatus: seed.minStatus,
        cityCode: null,
        vehicleTypeId: null,
        isActive: true,
      },
    });
    if (existing) continue;
    await prisma.cancellationPolicy.create({
      data: {
        cancelledBy: seed.cancelledBy,
        minStatus: seed.minStatus,
        feeAmount: seed.feeAmount,
        feeType: 'FLAT',
        freeCancelWindowSec: 120,
        isActive: true,
      },
    });
  }
}

async function seedPromotionsFixtures(prisma: Prisma) {
  const now = new Date();
  const in90Days = new Date(now.getTime() + 90 * 86400000);
  const in30Days = new Date(now.getTime() + 30 * 86400000);

  const cab = await prisma.vehicleType.findUnique({ where: { code: 'CAB_ECONOMY' } });

  const welcomePromo = await prisma.promotion.upsert({
    where: { code: 'WELCOME20' },
    update: {
      title: 'Welcome 20% off',
      isActive: true,
      validFrom: now,
      validTo: in90Days,
    },
    create: {
      code: 'WELCOME20',
      title: 'Welcome 20% off',
      description: 'First-ride discount for new riders',
      discountType: 'PERCENT',
      discountValue: 20,
      maxDiscount: 50,
      minFare: 40,
      applicableCity: null,
      applicableVehicleType: cab?.id ?? null,
      firstRideOnly: true,
      usageLimitTotal: 5000,
      usageLimitPerUser: 1,
      validFrom: now,
      validTo: in90Days,
      isActive: true,
    },
  });

  const sgrFlat = await prisma.promotion.upsert({
    where: { code: 'SGRFLAT30' },
    update: {
      title: 'Srinagar ₹30 off',
      isActive: true,
      validFrom: now,
      validTo: in90Days,
    },
    create: {
      code: 'SGRFLAT30',
      title: 'Srinagar ₹30 off',
      description: 'Flat discount for Srinagar rides',
      discountType: 'FIXED',
      discountValue: 30,
      maxDiscount: null,
      minFare: 60,
      applicableCity: 'SGR',
      applicableVehicleType: null,
      firstRideOnly: false,
      usageLimitTotal: 2000,
      usageLimitPerUser: 3,
      validFrom: now,
      validTo: in90Days,
      isActive: true,
    },
  });

  const sgrRiders = await prisma.audienceSegment.upsert({
    where: { code: 'SGR_RIDERS' },
    update: {
      name: 'Srinagar riders',
      rules: { cityCodes: ['SGR'] },
      estimatedSize: 1200,
      isDynamic: true,
    },
    create: {
      code: 'SGR_RIDERS',
      name: 'Srinagar riders',
      description: 'Riders active in Srinagar',
      rules: { cityCodes: ['SGR'] },
      estimatedSize: 1200,
      isDynamic: true,
    },
  });

  const firstRideSeg = await prisma.audienceSegment.upsert({
    where: { code: 'FIRST_RIDE' },
    update: {
      name: 'First-ride users',
      rules: { firstRideOnly: true },
      estimatedSize: 800,
      isDynamic: true,
    },
    create: {
      code: 'FIRST_RIDE',
      name: 'First-ride users',
      description: 'Users who have not completed a ride yet',
      rules: { firstRideOnly: true },
      estimatedSize: 800,
      isDynamic: true,
    },
  });

  const admin = await prisma.user.findFirst({
    where: { phoneNumber: '+10000000000', deletedAt: null },
  });

  const campaign = await prisma.promoCampaign.upsert({
    where: { code: 'LAUNCH2026' },
    update: {
      name: 'Launch acquisition 2026',
      status: 'RUNNING',
      budget: 100000,
      startsAt: now,
      endsAt: in90Days,
    },
    create: {
      code: 'LAUNCH2026',
      name: 'Launch acquisition 2026',
      objective: 'ACQUISITION',
      status: 'RUNNING',
      budget: 100000,
      spent: 2500,
      startsAt: now,
      endsAt: in90Days,
      createdBy: admin?.id ?? null,
    },
  });

  const existingTargets = await prisma.campaignTarget.count({
    where: { campaignId: campaign.id },
  });
  if (existingTargets === 0) {
    await prisma.campaignTarget.createMany({
      data: [
        {
          campaignId: campaign.id,
          segmentId: firstRideSeg.id,
          promotionId: welcomePromo.id,
        },
        {
          campaignId: campaign.id,
          segmentId: sgrRiders.id,
          promotionId: sgrFlat.id,
        },
      ],
    });
  }

  let batch = await prisma.couponBatch.findFirst({
    where: { promotionId: welcomePromo.id, name: 'Welcome launch batch' },
  });
  if (!batch) {
    batch = await prisma.couponBatch.create({
      data: {
        campaignId: campaign.id,
        promotionId: welcomePromo.id,
        name: 'Welcome launch batch',
        prefix: 'WLC',
        totalCount: 10,
        generatedCount: 0,
        perUserLimit: 1,
        expiresAt: in30Days,
        isActive: true,
      },
    });
  }

  const existingCoupons = await prisma.coupon.count({ where: { batchId: batch.id } });
  if (existingCoupons === 0) {
    const codes = Array.from({ length: 5 }, (_, i) => ({
      batchId: batch!.id,
      code: `WLCSEED${String(i + 1).padStart(3, '0')}`,
      status: 'ACTIVE' as const,
      expiresAt: in30Days,
    }));
    await prisma.coupon.createMany({ data: codes });
    await prisma.couponBatch.update({
      where: { id: batch.id },
      data: { generatedCount: codes.length },
    });
  }

  const bannerExists = await prisma.promoBanner.findFirst({
    where: { campaignId: campaign.id, title: 'Welcome offer' },
  });
  if (!bannerExists) {
    await prisma.promoBanner.create({
      data: {
        campaignId: campaign.id,
        title: 'Welcome offer',
        imageUrl: 'https://example.invalid/banners/welcome-offer.png',
        placement: 'HOME',
        actionUrl: 'https://example.invalid/offers/welcome',
        priority: 10,
        startsAt: now,
        endsAt: in90Days,
        isActive: true,
      },
    });
  }

  console.log(
    '  -> Seeded promotions WELCOME20/SGRFLAT30, segments, campaign LAUNCH2026, coupon batch, banner',
  );
}

async function seedReferralFixtures(prisma: Prisma) {
  const now = new Date();
  const in180Days = new Date(now.getTime() + 180 * 86400000);

  const program = await prisma.referralProgram.upsert({
    where: { code: 'REFLAUNCH' },
    update: {
      name: 'Launch referral',
      referrerReward: 50,
      refereeReward: 50,
      isActive: true,
      validFrom: now,
      validTo: in180Days,
    },
    create: {
      code: 'REFLAUNCH',
      name: 'Launch referral',
      referrerReward: 50,
      refereeReward: 50,
      rewardType: 'WALLET',
      qualifyingEvent: 'FIRST_RIDE',
      qualifyingThreshold: 1,
      maxReferralsPerUser: 25,
      rewardExpiryDays: 60,
      validFrom: now,
      validTo: in180Days,
      isActive: true,
    },
  });

  const milestoneSeeds = [
    { name: '5 friends', requiredReferrals: 5, bonusAmount: 100 },
    { name: '10 friends', requiredReferrals: 10, bonusAmount: 250 },
  ];
  for (const m of milestoneSeeds) {
    const existing = await prisma.referralMilestone.findFirst({
      where: { programId: program.id, name: m.name },
    });
    if (existing) {
      await prisma.referralMilestone.update({
        where: { id: existing.id },
        data: {
          requiredReferrals: m.requiredReferrals,
          bonusAmount: m.bonusAmount,
          isActive: true,
        },
      });
    } else {
      await prisma.referralMilestone.create({
        data: {
          programId: program.id,
          name: m.name,
          requiredReferrals: m.requiredReferrals,
          bonusAmount: m.bonusAmount,
          rewardType: 'WALLET',
          isActive: true,
        },
      });
    }
  }

  const referrer = await prisma.user.findFirst({
    where: { phoneNumber: '+10000000002', deletedAt: null },
  });
  const referee = await prisma.user.findFirst({
    where: { phoneNumber: '+10000000001', deletedAt: null },
  });

  if (referrer) {
    let code = await prisma.referralCode.findUnique({
      where: {
        userId_programId: { userId: referrer.id, programId: program.id },
      },
    });
    if (!code) {
      const byCode = await prisma.referralCode.findUnique({ where: { code: 'DEMOREF01' } });
      if (byCode) {
        code = await prisma.referralCode.update({
          where: { id: byCode.id },
          data: { userId: referrer.id, programId: program.id, isActive: true },
        });
      } else {
        code = await prisma.referralCode.create({
          data: {
            userId: referrer.id,
            programId: program.id,
            code: 'DEMOREF01',
            usesCount: 0,
            maxUses: 25,
            isActive: true,
          },
        });
      }
    } else if (!code.isActive) {
      code = await prisma.referralCode.update({
        where: { id: code.id },
        data: { isActive: true },
      });
    }

    if (referee) {
      const existingReferral = await prisma.referral.findFirst({
        where: { programId: program.id, refereeId: referee.id },
      });
      if (!existingReferral) {
        await prisma.referral.create({
          data: {
            programId: program.id,
            referrerId: referrer.id,
            refereeId: referee.id,
            referralCodeId: code.id,
            status: 'SIGNED_UP',
            qualifyingRides: 0,
            signedUpAt: now,
            expiresAt: in180Days,
          },
        });
        await prisma.referralCode.update({
          where: { id: code.id },
          data: { usesCount: { increment: 1 } },
        });
      }
    }
  }

  console.log('  -> Seeded referral program REFLAUNCH, milestones, code DEMOREF01, sample history');
}

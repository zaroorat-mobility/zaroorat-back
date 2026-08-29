import { randomUUID } from 'node:crypto';
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
    {
      phone: '+10000000004',
      profile: { firstName: 'Invite', lastName: 'Friend' },
      roles: ['customer'],
    },
    {
      phone: '+10000000005',
      profile: { firstName: 'Referred', lastName: 'One' },
      roles: ['customer'],
    },
    {
      phone: '+10000000006',
      profile: { firstName: 'Referred', lastName: 'Two' },
      roles: ['customer'],
    },
    {
      phone: '+10000000007',
      profile: { firstName: 'Referred', lastName: 'Three' },
      roles: ['customer'],
    },
    {
      phone: '+10000000008',
      profile: { firstName: 'Referred', lastName: 'Four' },
      roles: ['customer'],
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
  await seedGeographicReference(prisma);
  await seedServiceZones(prisma);
  await seedPricingFixtures(prisma);
  console.log('  -> Seeded GLOBAL fare rules, Srinagar surge zone/windows, cancellation policies');

  await seedBillingFixtures(prisma);
  console.log('  -> Seeded billing invoices, templates, and completed demo rides');

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

const SGR_BOUNDARY: number[][][] = [
  [
    [74.7, 34.0],
    [75.0, 34.0],
    [75.0, 34.2],
    [74.7, 34.2],
    [74.7, 34.0],
  ],
];

const BLR_BOUNDARY: number[][][] = [
  [
    [77.4, 12.8],
    [77.8, 12.8],
    [77.8, 13.2],
    [77.4, 13.2],
    [77.4, 12.8],
  ],
];

async function seedGeographicReference(prisma: Prisma) {
  const india = await prisma.country.upsert({
    where: { code: 'IN' },
    update: { name: 'India', isActive: true },
    create: { code: 'IN', name: 'India', isActive: true },
  });

  const stateSeeds = [
    { code: 'JK', name: 'Jammu & Kashmir' },
    { code: 'KA', name: 'Karnataka' },
  ];
  const stateByName = new Map<string, string>();
  for (const s of stateSeeds) {
    const row = await prisma.state.upsert({
      where: { countryId_code: { countryId: india.id, code: s.code } },
      update: { name: s.name, isActive: true },
      create: { countryId: india.id, code: s.code, name: s.name, isActive: true },
    });
    stateByName.set(s.name, row.id);
  }

  const cityBoundaries: Record<string, { boundary: number[][][]; center: [number, number] }> = {
    SGR: { boundary: SGR_BOUNDARY, center: [74.85, 34.1] },
    BLR: { boundary: BLR_BOUNDARY, center: [77.5946, 12.9716] },
  };

  for (const [code, geo] of Object.entries(cityBoundaries)) {
    const city = await prisma.city.findUnique({ where: { code } });
    if (!city) continue;
    const stateId =
      code === 'SGR' ? stateByName.get('Jammu & Kashmir') : stateByName.get('Karnataka');
    await prisma.city.update({
      where: { id: city.id },
      data: {
        ...(stateId ? { stateId } : {}),
        country: 'India',
      },
    });
    const boundaryJson = JSON.stringify({ type: 'Polygon', coordinates: geo.boundary });
    const centerJson = JSON.stringify({ type: 'Point', coordinates: geo.center });
    await prisma.$executeRaw`
      UPDATE cities
      SET boundary = ST_GeomFromGeoJSON(${boundaryJson}),
          center = ST_GeomFromGeoJSON(${centerJson})
      WHERE id = ${city.id}::uuid
    `;
  }
  console.log('  -> Seeded country IN, states, city boundaries for SGR/BLR');
}

async function seedServiceZones(prisma: Prisma) {
  const sgr = await prisma.city.findUnique({ where: { code: 'SGR' } });
  if (!sgr) return;

  const types = await prisma.vehicleType.findMany({ where: { isActive: true } });

  const zones: Array<{
    code: string;
    name: string;
    zoneType: 'SERVICE' | 'AIRPORT' | 'RESTRICTED';
    coordinates: number[][][];
    allowsPickup?: boolean;
  }> = [
    {
      code: 'SGR_CITYWIDE',
      name: 'Srinagar Citywide',
      zoneType: 'SERVICE',
      coordinates: SGR_BOUNDARY,
    },
    {
      code: 'SGR_AIRPORT',
      name: 'SGR Airport',
      zoneType: 'AIRPORT',
      coordinates: [
        [
          [74.76, 34.0],
          [74.79, 34.0],
          [74.79, 34.03],
          [74.76, 34.03],
          [74.76, 34.0],
        ],
      ],
    },
    {
      code: 'SGR_RESTRICTED_DEMO',
      name: 'Restricted Demo Area',
      zoneType: 'RESTRICTED',
      coordinates: [
        [
          [74.72, 34.05],
          [74.74, 34.05],
          [74.74, 34.07],
          [74.72, 34.07],
          [74.72, 34.05],
        ],
      ],
      allowsPickup: false,
    },
  ];

  for (const zone of zones) {
    const existing = await prisma.serviceZone.findFirst({
      where: { cityId: sgr.id, code: zone.code },
    });
    if (existing) {
      await prisma.serviceZone.update({
        where: { id: existing.id },
        data: {
          zoneType: zone.zoneType,
          allowsPickup: zone.allowsPickup ?? true,
        },
      });
      continue;
    }

    const geoJson = JSON.stringify({ type: 'Polygon', coordinates: zone.coordinates });
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO service_zones (
        id, city_id, code, name, zone_type, boundary, allows_pickup, allows_dropoff, is_active, created_at, updated_at
      )
      VALUES (
        gen_random_uuid(),
        ${sgr.id}::uuid,
        ${zone.code},
        ${zone.name},
        ${zone.zoneType}::"ServiceZoneType",
        ST_GeomFromGeoJSON(${geoJson}),
        ${zone.allowsPickup ?? true},
        true,
        true,
        NOW(),
        NOW()
      )
      RETURNING id
    `;
    const zoneId = rows[0]?.id;
    if (zoneId && types.length > 0 && zone.zoneType !== 'RESTRICTED') {
      for (const vt of types) {
        await prisma.serviceZoneVehicleType.upsert({
          where: {
            serviceZoneId_vehicleTypeId: { serviceZoneId: zoneId, vehicleTypeId: vt.id },
          },
          create: { serviceZoneId: zoneId, vehicleTypeId: vt.id },
          update: {},
        });
      }
    }
  }
  console.log('  -> Seeded service zones SGR_CITYWIDE, SGR_AIRPORT, SGR_RESTRICTED_DEMO');
}

async function seedPricingFixtures(prisma: Prisma) {
  const types = await prisma.vehicleType.findMany();
  const byCode = Object.fromEntries(types.map((t) => [t.code, t]));

  const fareSeeds: Array<{
    code: string;
    cityCode: string;
    serviceType?: 'INSTANT' | 'SCHEDULED' | 'RENTAL' | 'OUTSTATION';
    serviceZoneCode?: string;
    baseFare: number;
    minimumFare: number;
    perKmRate: number;
    perMinuteRate: number;
    freeWaitingMin: number;
    waitingPerMin: number;
    bookingFee: number;
    platformFeePct: number;
    taxRatePct: number;
    commissionRatePct: number;
  }> = [
    {
      code: 'CAB_ECONOMY',
      cityCode: 'GLOBAL',
      baseFare: 60,
      minimumFare: 80,
      perKmRate: 15,
      perMinuteRate: 1.5,
      freeWaitingMin: 5,
      waitingPerMin: 3,
      bookingFee: 5,
      platformFeePct: 2,
      taxRatePct: 5,
      commissionRatePct: 15,
    },
    {
      code: 'AUTO',
      cityCode: 'GLOBAL',
      baseFare: 30,
      minimumFare: 40,
      perKmRate: 10,
      perMinuteRate: 1,
      freeWaitingMin: 3,
      waitingPerMin: 2,
      bookingFee: 3,
      platformFeePct: 2,
      taxRatePct: 5,
      commissionRatePct: 12,
    },
    {
      code: 'BIKE',
      cityCode: 'GLOBAL',
      baseFare: 20,
      minimumFare: 25,
      perKmRate: 7,
      perMinuteRate: 0.8,
      freeWaitingMin: 2,
      waitingPerMin: 1.5,
      bookingFee: 2,
      platformFeePct: 1.5,
      taxRatePct: 5,
      commissionRatePct: 10,
    },
    {
      code: 'CAB_ECONOMY',
      cityCode: 'SGR',
      baseFare: 65,
      minimumFare: 85,
      perKmRate: 16,
      perMinuteRate: 1.6,
      freeWaitingMin: 5,
      waitingPerMin: 3,
      bookingFee: 5,
      platformFeePct: 2,
      taxRatePct: 5,
      commissionRatePct: 15,
    },
    {
      code: 'AUTO',
      cityCode: 'SGR',
      baseFare: 35,
      minimumFare: 45,
      perKmRate: 11,
      perMinuteRate: 1.1,
      freeWaitingMin: 3,
      waitingPerMin: 2,
      bookingFee: 3,
      platformFeePct: 2,
      taxRatePct: 5,
      commissionRatePct: 12,
    },
    {
      code: 'CAB_ECONOMY',
      cityCode: 'SGR',
      serviceType: 'SCHEDULED',
      baseFare: 70,
      minimumFare: 90,
      perKmRate: 16,
      perMinuteRate: 1.6,
      freeWaitingMin: 5,
      waitingPerMin: 3,
      bookingFee: 10,
      platformFeePct: 2.5,
      taxRatePct: 5,
      commissionRatePct: 15,
    },
    {
      code: 'CAB_ECONOMY',
      cityCode: 'SGR',
      serviceZoneCode: 'SGR_AIRPORT',
      baseFare: 90,
      minimumFare: 120,
      perKmRate: 18,
      perMinuteRate: 1.8,
      freeWaitingMin: 5,
      waitingPerMin: 4,
      bookingFee: 15,
      platformFeePct: 3,
      taxRatePct: 5,
      commissionRatePct: 18,
    },
  ];

  const sgr = await prisma.city.findUnique({ where: { code: 'SGR' } });
  const zoneByCode: Record<string, string> = {};
  if (sgr) {
    const zones = await prisma.serviceZone.findMany({ where: { cityId: sgr.id } });
    for (const z of zones) zoneByCode[z.code] = z.id;
  }

  for (const seed of fareSeeds) {
    const vt = byCode[seed.code];
    if (!vt) continue;
    const serviceZoneId = seed.serviceZoneCode ? (zoneByCode[seed.serviceZoneCode] ?? null) : null;
    if (seed.serviceZoneCode && !serviceZoneId) continue;

    const existing = await prisma.pricingRule.findFirst({
      where: {
        vehicleTypeId: vt.id,
        cityCode: seed.cityCode,
        serviceType: seed.serviceType ?? null,
        serviceZoneId,
        isActive: true,
      },
    });
    if (existing) continue;

    await prisma.pricingRule.create({
      data: {
        vehicleTypeId: vt.id,
        cityCode: seed.cityCode,
        ...(seed.serviceType ? { serviceType: seed.serviceType } : {}),
        ...(serviceZoneId ? { serviceZoneId } : {}),
        baseFare: seed.baseFare,
        minimumFare: seed.minimumFare,
        perKmRate: seed.perKmRate,
        perMinuteRate: seed.perMinuteRate,
        freeWaitingMin: seed.freeWaitingMin,
        waitingPerMin: seed.waitingPerMin,
        bookingFee: seed.bookingFee,
        platformFeePct: seed.platformFeePct,
        taxRatePct: seed.taxRatePct,
        commissionRatePct: seed.commissionRatePct,
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
            demandThresholdPct: 75,
            supplyThresholdPct: 25,
            peakHourStart: '08:00',
            peakHourEnd: '11:00',
            isPeakHourOnly: true,
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
            demandThresholdPct: 65,
            supplyThresholdPct: 30,
            peakHourStart: '17:00',
            peakHourEnd: '20:00',
            isPeakHourOnly: true,
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

  const admin = await prisma.user.findFirst({
    where: { phoneNumber: '+10000000000', deletedAt: null },
  });
  const demoPassenger = await prisma.user.findFirst({
    where: { phoneNumber: '+10000000002', deletedAt: null },
  });
  const inviteFriend = await prisma.user.findFirst({
    where: { phoneNumber: '+10000000004', deletedAt: null },
  });

  if (!admin) {
    console.log('  -> Skipped promotions seed (admin user missing)');
    return;
  }

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

  const demoRiderIds = [demoPassenger?.id, inviteFriend?.id].filter(Boolean) as string[];

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

  const demoUsersSeg = await prisma.audienceSegment.upsert({
    where: { code: 'DEMO_RIDERS' },
    update: {
      name: 'Demo rider accounts',
      rules: demoRiderIds.length > 0 ? { userIds: demoRiderIds } : { firstRideOnly: true },
      estimatedSize: demoRiderIds.length || 2,
      isDynamic: false,
    },
    create: {
      code: 'DEMO_RIDERS',
      name: 'Demo rider accounts',
      description: 'Seeded demo passenger accounts for local testing',
      rules: demoRiderIds.length > 0 ? { userIds: demoRiderIds } : { firstRideOnly: true },
      estimatedSize: demoRiderIds.length || 2,
      isDynamic: false,
    },
  });

  const campaign = await prisma.promoCampaign.upsert({
    where: { code: 'LAUNCH2026' },
    update: {
      name: 'Launch acquisition 2026',
      status: 'RUNNING',
      budget: 100000,
      startsAt: now,
      endsAt: in90Days,
      createdBy: admin.id,
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
      createdBy: admin.id,
    },
  });

  for (const target of [
    { segmentId: firstRideSeg.id, promotionId: welcomePromo.id },
    { segmentId: sgrRiders.id, promotionId: sgrFlat.id },
    { segmentId: demoUsersSeg.id, promotionId: welcomePromo.id },
  ]) {
    await prisma.campaignTarget.upsert({
      where: {
        campaignId_segmentId: { campaignId: campaign.id, segmentId: target.segmentId },
      },
      update: { promotionId: target.promotionId },
      create: {
        campaignId: campaign.id,
        segmentId: target.segmentId,
        promotionId: target.promotionId,
      },
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

  if (demoPassenger) {
    const assignedCoupon = await prisma.coupon.findFirst({
      where: { batchId: batch.id, code: 'WLCSEED001' },
    });
    if (assignedCoupon) {
      await prisma.coupon.update({
        where: { id: assignedCoupon.id },
        data: {
          userId: demoPassenger.id,
          status: 'ASSIGNED',
          assignedAt: now,
        },
      });
    }
  }

  const bannerSeeds: Array<{
    slug: string;
    title: string;
    placement: 'HOME' | 'RIDE' | 'WALLET' | 'SPLASH' | 'OFFERS';
    actionUrl: string;
    priority: number;
  }> = [
    {
      slug: 'banner-home-welcome',
      title: 'Welcome offer (HOME)',
      placement: 'HOME',
      actionUrl: '/offers/welcome',
      priority: 50,
    },
    {
      slug: 'banner-ride-sgr',
      title: 'Srinagar ride promo (RIDE)',
      placement: 'RIDE',
      actionUrl: '/offers/sgr-flat30',
      priority: 40,
    },
    {
      slug: 'banner-wallet-cashback',
      title: 'Wallet cashback (WALLET)',
      placement: 'WALLET',
      actionUrl: '/wallet/rewards',
      priority: 30,
    },
    {
      slug: 'banner-splash-launch',
      title: 'Launch splash (SPLASH)',
      placement: 'SPLASH',
      actionUrl: '/offers/welcome',
      priority: 20,
    },
    {
      slug: 'banner-offers-flat30',
      title: 'Srinagar flat ₹30 (OFFERS)',
      placement: 'OFFERS',
      actionUrl: '/offers/sgr-flat30',
      priority: 10,
    },
  ];

  for (const seed of bannerSeeds) {
    const imageFileId = await ensureSeedPromoBannerFile(prisma, admin.id, seed.slug);
    await ensurePromoBanner(prisma, {
      campaignId: campaign.id,
      title: seed.title,
      imageFileId,
      placement: seed.placement,
      actionUrl: seed.actionUrl,
      priority: seed.priority,
      startsAt: now,
      endsAt: in90Days,
      isActive: true,
    });
  }

  console.log('');
  console.log('  Promotions & campaigns dev workflow');
  console.log('  ───────────────────────────────────');
  console.log('  Admin creator : +10000000000 (LAUNCH2026 campaign owner)');
  console.log('  Promotions    : WELCOME20 (first ride), SGRFLAT30 (Srinagar)');
  console.log('  Segments      : FIRST_RIDE, SGR_RIDERS, DEMO_RIDERS (demo passengers)');
  console.log('  Coupon batch  : WLCSEED001–005 — WLCSEED001 assigned to +10000000002');
  console.log(
    '  Banners       : HOME, RIDE, WALLET, SPLASH, OFFERS (one active demo per placement)',
  );
  console.log('  Admin APIs    : /api/v1/admin/promotions, /campaigns, /promo-banners');
  console.log('');
}

async function ensureSeedPromoBannerFile(
  prisma: Prisma,
  ownerUserId: string,
  slug: string,
): Promise<string> {
  const storageKey = `pb/seed/${slug}.png`;
  const existing = await prisma.file.findFirst({ where: { storageKey } });
  if (existing) return existing.id;

  const now = new Date();
  return (
    await prisma.file.create({
      data: {
        ownerUserId,
        purpose: 'PROMO_BANNER',
        status: 'READY',
        storageKey,
        storageProvider: 'local',
        storageBucket: 'dev-seed',
        fileName: `${slug}.png`,
        contentType: 'image/png',
        detectedContentType: 'image/png',
        sizeBytes: 2048,
        scanStatus: 'SKIPPED',
        uploadExpiresAt: now,
        uploadedAt: now,
        verifiedAt: now,
        completedAt: now,
        scannedAt: now,
      },
    })
  ).id;
}

async function ensurePromoBanner(
  prisma: Prisma,
  input: {
    campaignId: string;
    title: string;
    imageFileId: string;
    placement: 'HOME' | 'RIDE' | 'WALLET' | 'SPLASH' | 'OFFERS';
    actionUrl: string;
    priority: number;
    startsAt: Date;
    endsAt: Date;
    isActive: boolean;
  },
) {
  const existing = await prisma.promoBanner.findFirst({
    where: { campaignId: input.campaignId, placement: input.placement },
    orderBy: { createdAt: 'asc' },
  });
  if (existing) {
    await prisma.promoBanner.update({
      where: { id: existing.id },
      data: {
        imageFileId: input.imageFileId,
        placement: input.placement,
        actionUrl: input.actionUrl,
        priority: input.priority,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        isActive: input.isActive,
      },
    });
    return;
  }
  await prisma.promoBanner.create({ data: input });
}

async function seedReferralFixtures(prisma: Prisma) {
  const now = new Date();
  const in180Days = new Date(now.getTime() + 180 * 86400000);

  // ── Rider program (customer app: share + claim, reward on first ride) ──
  const riderProgram = await prisma.referralProgram.upsert({
    where: { code: 'REFLAUNCH' },
    update: {
      name: 'Launch referral',
      audience: 'RIDER',
      referrerReward: 50,
      refereeReward: 50,
      rewardWallet: 'CUSTOMER',
      qualifyingEvent: 'FIRST_RIDE',
      qualifyingThreshold: 1,
      isActive: true,
      validFrom: now,
      validTo: in180Days,
    },
    create: {
      code: 'REFLAUNCH',
      name: 'Launch referral',
      audience: 'RIDER',
      referrerReward: 50,
      refereeReward: 50,
      rewardType: 'WALLET',
      rewardWallet: 'CUSTOMER',
      qualifyingEvent: 'FIRST_RIDE',
      qualifyingThreshold: 1,
      maxReferralsPerUser: 25,
      rewardExpiryDays: 60,
      validFrom: now,
      validTo: in180Days,
      isActive: true,
    },
  });

  const riderMilestones = [
    { name: '5 friends', requiredReferrals: 5, bonusAmount: 100 },
    { name: '10 friends', requiredReferrals: 10, bonusAmount: 250 },
  ];
  for (const m of riderMilestones) {
    const existing = await prisma.referralMilestone.findFirst({
      where: { programId: riderProgram.id, name: m.name },
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
          programId: riderProgram.id,
          name: m.name,
          requiredReferrals: m.requiredReferrals,
          bonusAmount: m.bonusAmount,
          rewardType: 'WALLET',
          isActive: true,
        },
      });
    }
  }

  const riderReferrer = await prisma.user.findFirst({
    where: { phoneNumber: '+10000000002', deletedAt: null },
  });
  const inviteFriend = await prisma.user.findFirst({
    where: { phoneNumber: '+10000000004', deletedAt: null },
  });
  const referredHistoryPhones = ['+10000000005', '+10000000006', '+10000000007', '+10000000008'];

  if (riderReferrer) {
    const riderCode = await ensureReferralCode(prisma, {
      userId: riderReferrer.id,
      programId: riderProgram.id,
      code: 'DEMOREF01',
      maxUses: 25,
    });

    await prisma.userProfile.updateMany({
      where: { userId: riderReferrer.id },
      data: { referralCode: riderCode.code },
    });

    if (inviteFriend) {
      await ensureReferralRow(prisma, {
        programId: riderProgram.id,
        referrerId: riderReferrer.id,
        refereeId: inviteFriend.id,
        referralCodeId: riderCode.id,
        status: 'SIGNED_UP',
        signedUpAt: now,
        expiresAt: in180Days,
      });
    }

    for (const phone of referredHistoryPhones) {
      const referee = await prisma.user.findFirst({
        where: { phoneNumber: phone, deletedAt: null },
      });
      if (!referee) continue;
      await ensureReferralRow(prisma, {
        programId: riderProgram.id,
        referrerId: riderReferrer.id,
        refereeId: referee.id,
        referralCodeId: riderCode.id,
        status: 'REWARDED',
        signedUpAt: now,
        qualifiedAt: now,
        rewardedAt: now,
        expiresAt: in180Days,
      });
    }

    const usesCount = await prisma.referral.count({
      where: { referralCodeId: riderCode.id },
    });
    await prisma.referralCode.update({
      where: { id: riderCode.id },
      data: { usesCount },
    });
  }

  // ── Driver program (driver app: share + claim, reward on approval) ──
  const driverProgram = await prisma.referralProgram.upsert({
    where: { code: 'REFDRIVER' },
    update: {
      name: 'Driver recruitment',
      audience: 'DRIVER',
      referrerReward: 500,
      refereeReward: 200,
      rewardWallet: 'DRIVER',
      qualifyingEvent: 'DRIVER_APPROVED',
      qualifyingThreshold: 1,
      isActive: true,
      validFrom: now,
      validTo: in180Days,
    },
    create: {
      code: 'REFDRIVER',
      name: 'Driver recruitment',
      audience: 'DRIVER',
      referrerReward: 500,
      refereeReward: 200,
      rewardType: 'WALLET',
      rewardWallet: 'DRIVER',
      qualifyingEvent: 'DRIVER_APPROVED',
      qualifyingThreshold: 1,
      maxReferralsPerUser: 50,
      rewardExpiryDays: 90,
      validFrom: now,
      validTo: in180Days,
      isActive: true,
    },
  });

  const driverMilestones = [
    { name: '3 drivers', requiredReferrals: 3, bonusAmount: 1000 },
    { name: '10 drivers', requiredReferrals: 10, bonusAmount: 5000 },
  ];
  for (const m of driverMilestones) {
    const existing = await prisma.referralMilestone.findFirst({
      where: { programId: driverProgram.id, name: m.name },
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
          programId: driverProgram.id,
          name: m.name,
          requiredReferrals: m.requiredReferrals,
          bonusAmount: m.bonusAmount,
          rewardType: 'WALLET',
          isActive: true,
        },
      });
    }
  }

  const referringDriverUser = await prisma.user.findFirst({
    where: { phoneNumber: '+10000000001', deletedAt: null },
  });
  const pendingApplicant = await prisma.user.findFirst({
    where: { phoneNumber: '+10000000003', deletedAt: null },
  });

  if (referringDriverUser) {
    const driverRow = await prisma.driver.findUnique({ where: { userId: referringDriverUser.id } });
    if (driverRow) {
      const driverCode = await ensureReferralCode(prisma, {
        userId: referringDriverUser.id,
        programId: driverProgram.id,
        code: 'DEMODRVREF',
        maxUses: 50,
      });

      if (pendingApplicant) {
        await ensureReferralRow(prisma, {
          programId: driverProgram.id,
          referrerId: referringDriverUser.id,
          refereeId: pendingApplicant.id,
          referralCodeId: driverCode.id,
          status: 'SIGNED_UP',
          signedUpAt: now,
          expiresAt: in180Days,
        });
        await prisma.driver.updateMany({
          where: { userId: pendingApplicant.id },
          data: { referralCodeId: driverCode.id },
        });
      }

      const driverUses = await prisma.referral.count({
        where: { referralCodeId: driverCode.id },
      });
      await prisma.referralCode.update({
        where: { id: driverCode.id },
        data: { usesCount: driverUses },
      });
    }
  }

  console.log('');
  console.log('  Referral dev workflow (RIDER lane — customer app)');
  console.log('  ─────────────────────────────────────────────────');
  console.log('  Referrer : Demo Passenger  +10000000002  code DEMOREF01');
  console.log('  Pending  : Invite Friend   +10000000004  (SIGNED_UP — reward on first ride)');
  console.log(
    '  History  : 4 REWARDED invites (+10000000005–08) → 1 away from "5 friends" milestone',
  );
  console.log('  APIs     : GET/POST /api/v1/referrals/rider/me | /apply');
  console.log('  Trigger  : complete a ride as +10000000004 → wallet credits + possible milestone');
  console.log('');
  console.log('  Referral dev workflow (DRIVER lane — driver app)');
  console.log('  ─────────────────────────────────────────────────');
  console.log('  Referrer : Demo Driver      +10000000001  code DEMODRVREF');
  console.log(
    '  Pending  : Pending Applicant +10000000003  (SIGNED_UP — reward on admin approval)',
  );
  console.log('  APIs     : GET/POST /api/v1/referrals/driver/me | /apply');
  console.log('  Trigger  : POST /api/v1/admin/drivers/:id/verify { status: "VERIFIED" }');
  console.log('');
}

async function seedBillingFixtures(prisma: Prisma) {
  const passengerUser = await prisma.user.findFirst({
    where: { phoneNumber: '+10000000002', deletedAt: null },
    include: { profile: true },
  });
  const inviteUser = await prisma.user.findFirst({
    where: { phoneNumber: '+10000000004', deletedAt: null },
    include: { profile: true },
  });
  const driverUser = await prisma.user.findFirst({
    where: { phoneNumber: '+10000000001', deletedAt: null },
    include: { profile: true },
  });

  if (!passengerUser || !driverUser) return;

  const driver = await prisma.driver.findUnique({
    where: { userId: driverUser.id },
    include: { profile: true },
  });
  if (!driver?.currentVehicleId) return;

  const vehicle = await prisma.vehicle.findUnique({ where: { id: driver.currentVehicleId } });
  const cabType = await prisma.vehicleType.findFirst({ where: { code: 'CAB_ECONOMY' } });
  if (!vehicle || !cabType) return;

  const driverName =
    driver.profile?.fullLegalName ??
    `${driverUser.profile?.firstName ?? 'Demo'} ${driverUser.profile?.lastName ?? 'Driver'}`;

  const templateSeeds = [
    {
      name: 'Standard Ride Invoice Template',
      templateType: 'RIDER_INVOICE',
      headerLogoText: 'ZAROORAT MOBILITY PVT LTD',
      address: '102, 1st Floor, Start-up Hangar, MG Road, Bengaluru - 560001',
      gstin: '29AAAAA1111A1Z1',
      footerTerms:
        'This is a computer generated invoice. No signature is required. Tax is calculated under reverse charge guidelines if applicable.',
      cgstRate: 2.5,
      sgstRate: 2.5,
      igstRate: 0,
      appliesTo: 'ride',
      isDefault: true,
    },
    {
      name: 'Driver Settlement Template',
      templateType: 'DRIVER_SETTLEMENT',
      headerLogoText: 'ZAROORAT MOBILITY PVT LTD',
      address: '102, 1st Floor, Start-up Hangar, MG Road, Bengaluru - 560001',
      gstin: '29AAAAA1111A1Z1',
      footerTerms: 'Driver commission settlement statement for completed rides.',
      cgstRate: 2.5,
      sgstRate: 2.5,
      igstRate: 0,
      appliesTo: 'services',
      isDefault: true,
    },
    {
      name: 'School Mode Reusable Receipt',
      templateType: 'SUBSCRIPTION_INVOICE',
      headerLogoText: 'ZAROORAT SCHOOL MOBILITY SERVICES',
      address: '44, Outer Ring Road, HSR Layout, Bengaluru - 560102',
      gstin: '29BBBBB2222B2Z2',
      footerTerms:
        'Applicable for school transportation billing cycles. Standard CGST and SGST rates apply as per service notifications.',
      cgstRate: 2.5,
      sgstRate: 2.5,
      igstRate: 0,
      appliesTo: 'school',
      isDefault: false,
    },
  ];

  for (const tpl of templateSeeds) {
    const existing = await prisma.invoiceTemplate.findFirst({ where: { name: tpl.name } });
    if (existing) {
      await prisma.invoiceTemplate.update({ where: { id: existing.id }, data: tpl });
    } else {
      await prisma.invoiceTemplate.create({ data: tpl });
    }
  }

  // FR-047. `tax_configs` was seeded with CGST/SGST/IGST rows that no pricing
  // path ever read — tax comes from `PricingRule.taxRatePct`. Seeding a table
  // nothing consumes is how a dead table looks alive.

  type RideSeed = {
    rideCode: string;
    customerId: string;
    customerName: string;
    fromRoute: string;
    toRoute: string;
    totalFare: number;
    taxAmount: number;
    commission: number;
    daysAgo: number;
    riderInvoiceNumber: string;
    driverInvoiceNumber: string;
    riderStatus: 'GENERATED' | 'PENDING';
  };

  const rideSeeds: RideSeed[] = [
    {
      rideCode: 'R-9812',
      customerId: passengerUser.id,
      customerName: `${passengerUser.profile?.firstName ?? 'Demo'} ${passengerUser.profile?.lastName ?? 'Passenger'}`,
      fromRoute: 'Lal Chowk',
      toRoute: 'Dal Lake',
      totalFare: 350,
      taxAmount: 16.67,
      commission: 24.5,
      daysAgo: 4,
      riderInvoiceNumber: 'INV-2026-001',
      driverInvoiceNumber: 'INV-2026-002',
      riderStatus: 'GENERATED',
    },
    {
      rideCode: 'R-9811',
      customerId: (inviteUser ?? passengerUser).id,
      customerName: inviteUser
        ? `${inviteUser.profile?.firstName ?? 'Invite'} ${inviteUser.profile?.lastName ?? 'Friend'}`
        : `${passengerUser.profile?.firstName ?? 'Demo'} ${passengerUser.profile?.lastName ?? 'Passenger'}`,
      fromRoute: 'Rajbagh',
      toRoute: 'Boulevard Road',
      totalFare: 120,
      taxAmount: 5.71,
      commission: 8.4,
      daysAgo: 4,
      riderInvoiceNumber: 'INV-2026-003',
      driverInvoiceNumber: 'INV-2026-003-D',
      riderStatus: 'GENERATED',
    },
    {
      rideCode: 'R-9810',
      customerId: passengerUser.id,
      customerName: `${passengerUser.profile?.firstName ?? 'Demo'} ${passengerUser.profile?.lastName ?? 'Passenger'}`,
      fromRoute: 'Airport Road',
      toRoute: 'Hazratbal',
      totalFare: 210,
      taxAmount: 10,
      commission: 14.7,
      daysAgo: 5,
      riderInvoiceNumber: 'INV-2026-004',
      driverInvoiceNumber: 'INV-2026-004-D',
      riderStatus: 'PENDING',
    },
    {
      rideCode: 'R-9808',
      customerId: passengerUser.id,
      customerName: `${passengerUser.profile?.firstName ?? 'Demo'} ${passengerUser.profile?.lastName ?? 'Passenger'}`,
      fromRoute: 'Bemina',
      toRoute: 'Lal Chowk',
      totalFare: 410,
      taxAmount: 19.52,
      commission: 28.7,
      daysAgo: 6,
      riderInvoiceNumber: 'INV-2026-005',
      driverInvoiceNumber: 'INV-2026-006',
      riderStatus: 'GENERATED',
    },
  ];

  for (const seed of rideSeeds) {
    let ride = await prisma.ride.findUnique({ where: { rideCode: seed.rideCode } });
    if (!ride) {
      const requestId = randomUUID();
      const rideId = randomUUID();
      const completedAt = new Date(Date.now() - seed.daysAgo * 24 * 60 * 60 * 1000);

      await prisma.$executeRawUnsafe(
        `INSERT INTO ride_requests
           (id, customer_id, vehicle_type_id, pickup_lat, pickup_lng, pickup_location,
            drop_lat, drop_lng, drop_location, pickup_address, drop_address,
            status, surge_multiplier, payment_method, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 34.0837, 74.7973,
                 ST_SetSRID(ST_MakePoint(74.7973, 34.0837), 4326)::geography,
                 34.1215, 74.8640,
                 ST_SetSRID(ST_MakePoint(74.8640, 34.1215), 4326)::geography,
                 $4, $5,
                 'MATCHED', 1.0, 'CASH', $6)`,
        requestId,
        seed.customerId,
        cabType.id,
        seed.fromRoute,
        seed.toRoute,
        completedAt,
      );

      await prisma.$executeRawUnsafe(
        `INSERT INTO rides
           (id, ride_code, request_id, customer_id, driver_id, vehicle_id, vehicle_type_id,
            status, payment_method, payment_status, pickup_location, pickup_address,
            drop_location, drop_address, accepted_at, started_at, completed_at,
            wait_time_min, is_scheduled, created_at, updated_at)
         VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid,
                 'COMPLETED', 'CASH', 'PAID',
                 ST_SetSRID(ST_MakePoint(74.7973, 34.0837), 4326)::geography, $8,
                 ST_SetSRID(ST_MakePoint(74.8640, 34.1215), 4326)::geography, $9,
                 $10, $10, $10,
                 0, false, $10, $10)`,
        rideId,
        seed.rideCode,
        requestId,
        seed.customerId,
        driver.id,
        vehicle.id,
        cabType.id,
        seed.fromRoute,
        seed.toRoute,
        completedAt,
      );

      await prisma.rideRequest.update({
        where: { id: requestId },
        data: { rideId },
      });

      const subtotal = seed.totalFare - seed.taxAmount;
      const driverEarning = seed.totalFare - seed.commission;

      await prisma.rideFare.create({
        data: {
          rideId,
          baseFare: 50,
          distanceFare: subtotal * 0.6,
          timeFare: subtotal * 0.25,
          subtotal,
          taxAmount: seed.taxAmount,
          totalFare: seed.totalFare,
          driverEarning,
          platformCommission: seed.commission,
        },
      });

      ride = await prisma.ride.findUniqueOrThrow({ where: { id: rideId } });
    }

    const issuedAt = ride.completedAt ?? new Date();

    await prisma.billingInvoice.upsert({
      where: { invoiceNumber: seed.riderInvoiceNumber },
      update: {
        rideId: ride.id,
        recipientUserId: seed.customerId,
        recipientName: seed.customerName,
        bookingCode: seed.rideCode,
        amount: seed.totalFare,
        taxAmount: seed.taxAmount,
        status: seed.riderStatus,
        fromRoute: seed.fromRoute,
        toRoute: seed.toRoute,
        issuedAt,
      },
      create: {
        invoiceNumber: seed.riderInvoiceNumber,
        rideId: ride.id,
        recipientType: 'RIDER',
        recipientUserId: seed.customerId,
        recipientName: seed.customerName,
        bookingCode: seed.rideCode,
        amount: seed.totalFare,
        taxAmount: seed.taxAmount,
        status: seed.riderStatus,
        fromRoute: seed.fromRoute,
        toRoute: seed.toRoute,
        issuedAt,
      },
    });

    await prisma.billingInvoice.upsert({
      where: { invoiceNumber: seed.driverInvoiceNumber },
      update: {
        rideId: ride.id,
        recipientUserId: driverUser.id,
        recipientName: driverName,
        bookingCode: seed.rideCode,
        amount: seed.commission,
        taxAmount: 0,
        status: 'GENERATED',
        fromRoute: seed.fromRoute,
        toRoute: seed.toRoute,
        issuedAt,
      },
      create: {
        invoiceNumber: seed.driverInvoiceNumber,
        rideId: ride.id,
        recipientType: 'DRIVER',
        recipientUserId: driverUser.id,
        recipientName: driverName,
        bookingCode: seed.rideCode,
        amount: seed.commission,
        taxAmount: 0,
        status: 'GENERATED',
        fromRoute: seed.fromRoute,
        toRoute: seed.toRoute,
        issuedAt,
      },
    });
  }
}

async function ensureReferralCode(
  prisma: Prisma,
  input: { userId: string; programId: string; code: string; maxUses: number },
) {
  let code = await prisma.referralCode.findUnique({
    where: { userId_programId: { userId: input.userId, programId: input.programId } },
  });
  if (!code) {
    const byCode = await prisma.referralCode.findUnique({ where: { code: input.code } });
    if (byCode) {
      code = await prisma.referralCode.update({
        where: { id: byCode.id },
        data: {
          userId: input.userId,
          programId: input.programId,
          maxUses: input.maxUses,
          isActive: true,
        },
      });
    } else {
      code = await prisma.referralCode.create({
        data: {
          userId: input.userId,
          programId: input.programId,
          code: input.code,
          usesCount: 0,
          maxUses: input.maxUses,
          isActive: true,
        },
      });
    }
  } else if (!code.isActive) {
    code = await prisma.referralCode.update({
      where: { id: code.id },
      data: { isActive: true, maxUses: input.maxUses },
    });
  }
  return code;
}

async function ensureReferralRow(
  prisma: Prisma,
  input: {
    programId: string;
    referrerId: string;
    refereeId: string;
    referralCodeId: string;
    status: 'SIGNED_UP' | 'REWARDED';
    signedUpAt: Date;
    expiresAt: Date;
    qualifiedAt?: Date;
    rewardedAt?: Date;
  },
) {
  const existing = await prisma.referral.findUnique({
    where: { programId_refereeId: { programId: input.programId, refereeId: input.refereeId } },
  });
  if (existing) {
    await prisma.referral.update({
      where: { id: existing.id },
      data: {
        referrerId: input.referrerId,
        referralCodeId: input.referralCodeId,
        status: input.status,
        signedUpAt: input.signedUpAt,
        qualifiedAt: input.qualifiedAt ?? null,
        rewardedAt: input.rewardedAt ?? null,
        expiresAt: input.expiresAt,
      },
    });
    return;
  }
  await prisma.referral.create({
    data: {
      programId: input.programId,
      referrerId: input.referrerId,
      refereeId: input.refereeId,
      referralCodeId: input.referralCodeId,
      status: input.status,
      qualifyingRides: input.status === 'REWARDED' ? 1 : 0,
      signedUpAt: input.signedUpAt,
      ...(input.qualifiedAt ? { qualifiedAt: input.qualifiedAt } : {}),
      ...(input.rewardedAt ? { rewardedAt: input.rewardedAt } : {}),
      expiresAt: input.expiresAt,
    },
  });
}

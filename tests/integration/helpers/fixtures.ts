import { randomUUID } from 'node:crypto';

import { driverConfig } from '../../../src/config/driver/driver.config.js';
import { vehicleConfig } from '../../../src/config/vehicle/vehicle.config.js';
import { db } from './harness.js';

export async function grantRole(userId: string, slug: string): Promise<void> {
  const role = await db().client.role.findUniqueOrThrow({ where: { slug } });
  const existing = await db().client.userRoleAssignment.findFirst({
    where: { userId, roleId: role.id, revokedAt: null },
  });
  if (!existing) {
    await db().client.userRoleAssignment.create({ data: { userId, roleId: role.id } });
  }
}

export async function makeDriver(
  userId: string,
  options: { verified?: boolean; suspended?: boolean } = {},
): Promise<string> {
  const verified = options.verified !== false;

  const driver = await db().client.driver.create({
    data: {
      userId,
      driverCode: `DRV_${randomUUID().slice(0, 8).toUpperCase()}`,
      verificationStatus: verified ? 'VERIFIED' : 'PENDING',
      isSuspended: options.suspended ?? false,
    },
  });

  if (verified) {
    for (const documentType of driverConfig.requiredDocumentTypes) {
      await db().client.driverDocument.create({
        data: {
          driverId: driver.id,
          documentType,
          verificationStatus: 'VERIFIED',
          fileUrl: `https://example.invalid/${documentType.toLowerCase()}.jpg`,
        },
      });
    }
  }

  return driver.id;
}

export async function makeVehicleType(
  options: { isActive?: boolean; code?: string; name?: string; perKmRate?: number } = {},
): Promise<string> {
  const type = await db().client.vehicleType.create({
    data: {
      code: options.code ?? `VT_${randomUUID().slice(0, 8)}`,
      name: options.name ?? 'Hatchback',
      isActive: options.isActive ?? true,
      ...(options.perKmRate !== undefined ? { perKmRate: options.perKmRate } : {}),
    },
  });
  return type.id;
}

export async function makeVehicle(
  vehicleTypeId: string,
  options: { verified?: boolean; isActive?: boolean } = {},
): Promise<string> {
  const vehicle = await db().client.vehicle.create({
    data: {
      registrationNumber: `KA01${randomUUID().slice(0, 6).toUpperCase()}`,
      vehicleTypeId,
      isActive: options.isActive ?? true,
      verificationStatus: options.verified === false ? 'PENDING' : 'VERIFIED',
      ...(options.verified === false ? {} : { verifiedAt: new Date() }),
    },
  });

  if (options.verified !== false) {
    for (const documentType of vehicleConfig.requiredDocumentTypes) {
      await db().client.vehicleDocument.create({
        data: {
          vehicleId: vehicle.id,
          documentType,
          verificationStatus: 'VERIFIED',
          fileUrl: `https://example.invalid/${documentType.toLowerCase()}.jpg`,
        },
      });
    }
  }

  return vehicle.id;
}

/// Gives a driver an operable vehicle: an active, VERIFIED vehicle with every
/// required vehicle document VERIFIED, assigned to them. Going online now gates
/// on this as well as on the driver's own documents, so any fixture that brings
/// a driver online needs it.
export async function makeAssignedVehicle(
  driverId: string,
  options: { vehicleTypeId?: string; verified?: boolean } = {},
): Promise<{ vehicleId: string; vehicleTypeId: string }> {
  const vehicleTypeId = options.vehicleTypeId ?? (await makeVehicleType());
  const vehicleId = await makeVehicle(vehicleTypeId, {
    ...(options.verified !== undefined ? { verified: options.verified } : {}),
  });

  await db().client.vehicle.update({
    where: { id: vehicleId },
    data: { currentDriverId: driverId },
  });
  await db().client.vehicleAssignment.create({
    data: { driverId, vehicleId, status: 'ACTIVE' },
  });
  await db().client.driver.update({
    where: { id: driverId },
    data: { currentVehicleId: vehicleId },
  });

  return { vehicleId, vehicleTypeId };
}

export async function makeRideRequest(customerId: string, vehicleTypeId: string): Promise<string> {
  const id = randomUUID();
  await db().client.$executeRawUnsafe(
    `INSERT INTO ride_requests
       (id, customer_id, vehicle_type_id, pickup_lat, pickup_lng, pickup_location,
        drop_lat, drop_lng, status, surge_multiplier, payment_method, created_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 12.9716, 77.5946,
             ST_SetSRID(ST_MakePoint(77.5946, 12.9716), 4326)::geography,
             12.9352, 77.6245, 'SEARCHING', 1.0, 'CASH', now())`,
    id,
    customerId,
    vehicleTypeId,
  );
  return id;
}

export async function makeRide(input: {
  requestId: string;
  customerId: string;
  driverId: string;
  vehicleId: string;
  vehicleTypeId: string;
  status?: string;
}): Promise<string> {
  const id = randomUUID();
  await db().client.$executeRawUnsafe(
    `INSERT INTO rides
       (id, ride_code, request_id, customer_id, driver_id, vehicle_id, vehicle_type_id,
        status, payment_method, payment_status, pickup_location, accepted_at,
        wait_time_min, is_scheduled, created_at, updated_at)
     VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid,
             $8::"RideStatus", 'CASH', 'PENDING',
             ST_SetSRID(ST_MakePoint(77.5946, 12.9716), 4326)::geography, now(),
             0, false, now(), now())`,
    id,
    `RIDE_${randomUUID().slice(0, 8).toUpperCase()}`,
    input.requestId,
    input.customerId,
    input.driverId,
    input.vehicleId,
    input.vehicleTypeId,
    input.status ?? 'ACCEPTED',
  );
  return id;
}

export async function makePaidTransaction(
  userId: string,
  amount: number,
): Promise<{ intentId: string; transactionId: string }> {
  const intent = await db().client.paymentIntent.create({
    data: {
      userId,
      amount,
      currency: 'INR',
      methodType: 'CARD',
      idempotencyKey: `seed_${randomUUID()}`,
      status: 'SUCCEEDED',
      gateway: 'mock',
      gatewayIntentId: `mock_pi_${randomUUID().slice(0, 8)}`,
    },
  });

  const transaction = await db().client.paymentTransaction.create({
    data: {
      intentId: intent.id,
      userId,
      txnType: 'PAYMENT',
      amount,
      currency: 'INR',
      status: 'SUCCEEDED',
      gateway: 'mock',
    },
  });

  return { intentId: intent.id, transactionId: transaction.id };
}

export async function makeSettlement(
  driverId: string,
  netPayable: number,
  options: { status?: string } = {},
): Promise<string> {
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - Math.floor(Math.random() * 1e9));

  const settlement = await db().client.driverSettlement.create({
    data: {
      driverId,
      periodStart,
      periodEnd,
      grossEarnings: netPayable,
      commission: 0,
      adjustments: 0,
      netPayable,
      status: options.status ?? 'PENDING',
    },
  });
  return settlement.id;
}

export async function makePendingIntent(userId: string, amount: number): Promise<string> {
  const intent = await db().client.paymentIntent.create({
    data: {
      userId,
      amount,
      currency: 'INR',
      methodType: 'CARD',
      idempotencyKey: `seed_${randomUUID()}`,
      status: 'PENDING',
      gateway: 'mock',
      gatewayIntentId: `mock_pi_${randomUUID().slice(0, 8)}`,
    },
  });
  return intent.id;
}

/// A live dispatch offer, the way a dispatch round would leave one. Accepting a
/// ride now requires the driver to actually hold one — the offer is checked, not
/// merely written — so any fixture that drives `/rides/accept` needs this.
export async function makeDispatchOffer(
  requestId: string,
  driverId: string,
  options: { expiresInMs?: number; response?: string } = {},
): Promise<string> {
  const dispatch = await db().client.rideDispatch.create({
    data: {
      requestId,
      driverId,
      response: (options.response ?? 'PENDING') as 'PENDING',
      expiresAt: new Date(Date.now() + (options.expiresInMs ?? 60_000)),
    },
  });
  return dispatch.id;
}

/// Puts a driver's status row straight into ONLINE. The go-online endpoint is
/// the real path and gates on documents and vehicle; this is for fixtures that
/// need the status without re-testing that gate.
export async function markDriverOnline(driverId: string): Promise<void> {
  await db().client.driverOnlineStatus.upsert({
    where: { driverId },
    create: { driverId, status: 'ONLINE', lastOnlineAt: new Date() },
    update: { status: 'ONLINE', lastOnlineAt: new Date() },
  });
}

/// Gives a user the profile name that ride booking requires.
///
/// `RideRequestService.createRequest` refuses with 422 INCOMPLETE_PROFILE
/// unless both `firstName` and `lastName` are set. Without this, a freshly
/// logged-in user cannot book, and every assertion after the booking step in a
/// suite is unreachable — which is exactly why 15 integration tests appeared to
/// "fail on payments" while never reaching a payment assertion at all.
///
/// Called from `loginAs`, so every test user can book by default. Any suite
/// that needs to exercise the incomplete-profile path should clear the names
/// explicitly rather than relying on the absence of this.
export async function completeProfile(
  userId: string,
  firstName = 'Test',
  lastName = 'Rider',
): Promise<void> {
  await db().client.userProfile.upsert({
    where: { userId },
    create: { userId, firstName, lastName },
    update: { firstName, lastName },
  });
}

export async function ensureCountry(code = 'IN', name = 'India'): Promise<string> {
  const country = await db().client.country.upsert({
    where: { code },
    update: { name, isActive: true },
    create: { code, name, isActive: true },
  });
  return country.id;
}

export async function ensureCity(
  code: string,
  name: string,
  state: string | null = null,
): Promise<string> {
  const city = await db().client.city.upsert({
    where: { code },
    update: { name, state, isActive: true },
    create: {
      code,
      name,
      state,
      country: 'India',
      isActive: true,
      launchedAt: new Date(),
    },
  });
  return city.id;
}

export async function ensureServiceZone(
  cityCode: string,
  zoneCode: string,
  name: string,
  coordinates: number[][][],
): Promise<string> {
  const cityId = await ensureCity(cityCode, cityCode);
  const existing = await db().client.serviceZone.findFirst({
    where: { cityId, code: zoneCode },
  });
  if (existing) return existing.id;

  const geoJson = JSON.stringify({ type: 'Polygon', coordinates });
  const rows = await db().client.$queryRaw<Array<{ id: string }>>`
    INSERT INTO service_zones (id, city_id, code, name, zone_type, boundary, allows_pickup, allows_dropoff, is_active, created_at, updated_at)
    VALUES (
      gen_random_uuid(),
      ${cityId}::uuid,
      ${zoneCode},
      ${name},
      'SERVICE'::"ServiceZoneType",
      ST_GeomFromGeoJSON(${geoJson}),
      true,
      true,
      true,
      NOW(),
      NOW()
    )
    RETURNING id
  `;
  return rows[0]!.id;
}

export async function createPricingRuleDirect(data: {
  vehicleTypeId: string;
  cityCode: string;
  baseFare: number;
  serviceType?: 'INSTANT' | 'SCHEDULED' | 'RENTAL' | 'OUTSTATION' | null;
  serviceZoneId?: string | null;
  minimumFare?: number;
  perKmRate?: number;
  perMinuteRate?: number;
  bookingFee?: number;
  taxRatePct?: number;
  commissionRatePct?: number;
  isActive?: boolean;
}): Promise<string> {
  const row = await db().client.pricingRule.create({
    data: {
      vehicleTypeId: data.vehicleTypeId,
      cityCode: data.cityCode,
      serviceType: data.serviceType ?? null,
      serviceZoneId: data.serviceZoneId ?? null,
      baseFare: data.baseFare,
      minimumFare: data.minimumFare ?? data.baseFare,
      perKmRate: data.perKmRate ?? 0,
      perMinuteRate: data.perMinuteRate ?? 0,
      bookingFee: data.bookingFee ?? 0,
      ...(data.taxRatePct !== undefined ? { taxRatePct: data.taxRatePct } : {}),
      ...(data.commissionRatePct !== undefined
        ? { commissionRatePct: data.commissionRatePct }
        : {}),
      isActive: data.isActive ?? true,
      effectiveFrom: new Date(),
    },
  });
  return row.id;
}

export async function seedBillingInvoiceFixtures(): Promise<void> {
  const customer = await db().client.user.create({
    data: {
      phoneNumber: `+9199${randomUUID().slice(0, 8)}`,
      profile: { create: { firstName: 'Demo', lastName: 'Passenger' } },
    },
  });
  const driverUser = await db().client.user.create({
    data: {
      phoneNumber: `+9198${randomUUID().slice(0, 8)}`,
      profile: { create: { firstName: 'Demo', lastName: 'Driver' } },
    },
  });
  const driverId = await makeDriver(driverUser.id, { verified: true });
  const { vehicleId, vehicleTypeId } = await makeAssignedVehicle(driverId);
  const requestId = await makeRideRequest(customer.id, vehicleTypeId);
  const rideId = await makeRide({
    requestId,
    customerId: customer.id,
    driverId,
    vehicleId,
    vehicleTypeId,
    status: 'COMPLETED',
  });

  await db().client.ride.update({
    where: { id: rideId },
    data: {
      completedAt: new Date(),
      paymentStatus: 'PAID',
      pickupAddress: 'Lal Chowk',
      dropAddress: 'Dal Lake',
    },
  });

  await db().client.rideFare.create({
    data: {
      rideId,
      baseFare: 50,
      distanceFare: 200,
      timeFare: 83.33,
      subtotal: 333.33,
      taxAmount: 16.67,
      totalFare: 350,
      driverEarning: 325.5,
      platformCommission: 24.5,
    },
  });

  await db().client.invoiceTemplate.create({
    data: {
      name: 'Standard Ride Invoice Template',
      headerLogoText: 'ZAROORAT MOBILITY PVT LTD',
      address: '102, MG Road, Bengaluru - 560001',
      gstin: '29AAAAA1111A1Z1',
      footerTerms: 'Computer generated invoice.',
      cgstRate: 2.5,
      sgstRate: 2.5,
      igstRate: 0,
      appliesTo: 'ride',
      isDefault: true,
    },
  });

  await db().client.billingInvoice.createMany({
    data: [
      {
        invoiceNumber: 'INV-TEST-001',
        rideId,
        recipientType: 'RIDER',
        recipientUserId: customer.id,
        recipientName: 'Demo Passenger',
        bookingCode: 'R-9812',
        amount: 350,
        taxAmount: 16.67,
        status: 'GENERATED',
        fromRoute: 'Lal Chowk',
        toRoute: 'Dal Lake',
      },
      {
        invoiceNumber: 'INV-TEST-002',
        rideId,
        recipientType: 'DRIVER',
        recipientUserId: driverUser.id,
        recipientName: 'Demo Driver',
        bookingCode: 'R-9812',
        amount: 24.5,
        taxAmount: 0,
        status: 'GENERATED',
        fromRoute: 'Lal Chowk',
        toRoute: 'Dal Lake',
      },
    ],
  });
}

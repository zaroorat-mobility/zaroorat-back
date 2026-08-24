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

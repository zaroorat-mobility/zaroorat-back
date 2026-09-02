import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

import { paymentConfig } from '../../../src/config/payment/payment.config.js';

import { db, drainOutbox, loginAs, type LoggedInUser } from './harness.js';
import {
  completeProfile,
  grantRole,
  makeAssignedVehicle,
  makeDispatchOffer,
  makeDriver,
  makeVehicleType,
  markDriverOnline,
} from './fixtures.js';
import { Decimal } from '../../../src/modules/payments/types/index.js';

export interface RideWorld {
  customer: LoggedInUser;
  driver: LoggedInUser;
  driverId: string;
  vehicleId: string;
  vehicleTypeId: string;
}

export interface FareRow {
  totalFare: Decimal;
  driverEarning: Decimal;
  platformCommission: Decimal;
  /// FR-006. Tax and the platform fee are destinations of their own now, so a
  /// test reconciling a ledger group has to be able to name them.
  taxAmount: Decimal;
  platformFee: Decimal;
}

/// A rider, a verified online driver with an assigned vehicle, and a vehicle
/// type — everything `POST /rides/requests` through `/complete` needs.
///
/// Four separate gates make a ride refuse to book or accept, and each one hid
/// the next when this was first written: a rider with no profile name is 422
/// INCOMPLETE_PROFILE, acceptance without a dispatch offer is 404
/// RIDE_OFFER_NOT_FOUND, an offline driver is 409 DRIVER_NOT_AVAILABLE, and a
/// driver with no active assignment is 409 VEHICLE_MISMATCH.
export async function rideWorld(
  app: FastifyInstance,
  phones: { customer: string; driver: string },
): Promise<RideWorld> {
  const initialCustomer = await loginAs(app, phones.customer);
  await completeProfile(initialCustomer.userId);
  const initialDriver = await loginAs(app, phones.driver);
  await grantRole(initialDriver.userId, 'driver');
  const driverId = await makeDriver(initialDriver.userId, { verified: true });
  const vehicleTypeId = await makeVehicleType();
  const { vehicleId } = await makeAssignedVehicle(driverId, { vehicleTypeId, verified: true });
  await markDriverOnline(driverId);

  // Setup publishes events — a granted role, a verified driver — and with the
  // real consumers subscribed those bump the user's token epoch the moment the
  // outbox drains, staling every token issued before. Draining here and
  // logging in afterwards means these tokens survive every later drain.
  await drainOutbox();
  const customer = await loginAs(app, phones.customer);
  const driver = await loginAs(app, phones.driver);

  return { customer, driver, driverId, vehicleId, vehicleTypeId };
}

/// Books, accepts, starts and completes one ride over real HTTP, returning the
/// fare the server priced it at.
export async function completeRide(
  app: FastifyInstance,
  world: RideWorld,
  options: { distanceKm: number; durationMin: number; paymentMethod?: string },
): Promise<{ rideId: string; fare: FareRow }> {
  const requested = await app.inject({
    method: 'POST',
    url: '/api/v1/rides/requests',
    headers: world.customer.authHeader,
    payload: {
      vehicleTypeId: world.vehicleTypeId,
      pickupLat: 12.9716,
      pickupLng: 77.5946,
      // ~0.009 deg of latitude is ~1 km, so the quoted route scales with the
      // distance this ride will report. Quoting one fixed short route and then
      // completing 40 km is refused by assertPlausibleTripData.
      dropLat: 12.9716 + options.distanceKm * 0.009,
      dropLng: 77.5946,
      paymentMethod: options.paymentMethod ?? 'CARD',
    },
  });
  assert.equal(requested.statusCode, 200, requested.payload);
  const requestId = requested.json().data.id;

  await makeDispatchOffer(requestId, world.driverId);

  const accepted = await app.inject({
    method: 'POST',
    url: '/api/v1/rides/accept',
    headers: world.driver.authHeader,
    payload: { requestId, vehicleId: world.vehicleId },
  });
  assert.equal(accepted.statusCode, 200, accepted.payload);

  const rideId = accepted.json().data.ride.id;
  const otpCode = accepted.json().data.plaintextOtp;

  const arrived = await app.inject({
    method: 'POST',
    url: `/api/v1/rides/${rideId}/arrive`,
    headers: world.driver.authHeader,
    payload: {},
  });
  assert.equal(arrived.statusCode, 200, arrived.payload);

  const started = await app.inject({
    method: 'POST',
    url: `/api/v1/rides/${rideId}/start`,
    headers: world.driver.authHeader,
    payload: { otpCode },
  });
  assert.equal(started.statusCode, 200, started.payload);

  const completed = await app.inject({
    method: 'POST',
    url: `/api/v1/rides/${rideId}/complete`,
    headers: world.driver.authHeader,
    payload: { actualDistanceKm: options.distanceKm, actualDurationMin: options.durationMin },
  });
  assert.equal(completed.statusCode, 200, completed.payload);

  const fare = await db().client.rideFare.findUniqueOrThrow({ where: { rideId } });
  return { rideId, fare: fare as unknown as FareRow };
}

/// Net position of a ledger account: credits less debits.
export async function accountBalance(
  account: string,
  scope: { accountRefId?: string; rideId?: string } = {},
): Promise<Decimal> {
  const entries = await db().client.paymentLedgerEntry.findMany({
    where: {
      account,
      ...(scope.accountRefId ? { accountRefId: scope.accountRefId } : {}),
      ...(scope.rideId ? { referenceType: 'RIDE', referenceId: scope.rideId } : {}),
    },
  });
  return entries.reduce(
    (sum, e) => (e.direction === 'CREDIT' ? sum.add(e.amount) : sum.sub(e.amount)),
    new Decimal(0),
  );
}

/// Puts real, ledger-backed money in a rider's wallet.
///
/// Deliberately not a direct `customer_wallets` update: a balance that no
/// payment produced is exactly the defect US1 closed, and seeding one would
/// leave the wallet position disagreeing with the ledger in every assertion
/// made afterwards.
export async function fundWallet(
  app: FastifyInstance,
  user: LoggedInUser,
  amount: number,
): Promise<void> {
  const topup = await app.inject({
    method: 'POST',
    url: '/api/v1/payments/wallet/topup',
    headers: { ...user.authHeader, 'idempotency-key': randomUUID() },
    payload: { amount },
  });
  assert.equal(topup.statusCode, 200, topup.payload);

  const body = JSON.stringify({
    id: `evt_${randomUUID()}`,
    type: 'payment.succeeded',
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: topup.json().data.intentId } },
  });
  const delivered = await app.inject({
    method: 'POST',
    url: '/api/v1/payments/webhooks/razorpay',
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature': createHmac('sha256', paymentConfig.webhookSecret)
        .update(body)
        .digest('hex'),
    },
    payload: body,
  });
  assert.equal(delivered.statusCode, 200, delivered.payload);
}

/// Puts a delivered outbox row back on the queue, the way a relay that died
/// after handing an envelope to the bus but before marking it published
/// would.
export async function replayOutboxEvent(eventType: string): Promise<void> {
  await db().client.outboxEvent.updateMany({
    where: { eventType },
    data: { status: 'PENDING', claimedAt: null, nextAttemptAt: new Date() },
  });
}

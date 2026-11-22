import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, bootEventConsumers, db, drainOutbox, resetState } from './helpers/harness.js';
import {
  acceptRide,
  bookRideRequest,
  completeRide,
  fundWallet,
  rideWorld,
} from './helpers/ride-flow.js';
import { markDriverOnline } from './helpers/fixtures.js';
import type { Unsubscribe } from '../../src/core/events/index.js';

/// Migration `20260918170000_no_new_wallet_rides` (CRITICAL FIX — C1).
///
/// Tests PostgreSQL BEFORE INSERT OR UPDATE triggers:
///   1. Reject new WALLET inserts for requests and rides at DB and HTTP level.
///   2. Reject updating existing CASH/UPI/CARD requests or rides to WALLET.
///   3. Allow new CASH, UPI, and CARD requests and rides.
///   4. Allow status, payment_status, and lifecycle updates on historical WALLET rows without blocking.
///   5. Ensure no row is created when a WALLET request is rejected.
describe('C1 — DB trigger prevention of new WALLET rides without freezing historical rides (integration)', () => {
  let app: FastifyInstance;
  let stopConsumers: Unsubscribe;

  before(async () => {
    app = await bootApp();
    stopConsumers = bootEventConsumers();
  });
  after(async () => {
    stopConsumers();
    await app.close();
  });
  afterEach(async () => {
    await resetState();
  });

  // Requirement 1 & 12: New WALLET ride/request is rejected, no row created
  it('1 & 12. Rejects new WALLET ride_request and writes no row to database', async () => {
    const w = await rideWorld(app, { customer: '+919876690201', driver: '+919876690202' });

    // HTTP level attempt
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/rides/requests',
      headers: w.customer.authHeader,
      payload: {
        vehicleTypeId: w.vehicleTypeId,
        pickupLat: 12.9716,
        pickupLng: 77.5946,
        dropLat: 12.9716 + 0.045,
        dropLng: 77.5946,
        paymentMethod: 'WALLET',
      },
    });
    assert.equal(res.statusCode, 400, 'HTTP request must be rejected with 400 Validation Error');

    // DB-level direct INSERT attempt with WALLET
    await assert.rejects(
      db().client.$executeRaw`
        INSERT INTO "ride_requests" (
          "id", "customer_id", "vehicle_type_id", "pickup_lat", "pickup_lng",
          "status", "payment_method"
        ) VALUES (
          gen_random_uuid(), ${w.customer.userId}::uuid, ${w.vehicleTypeId}::uuid, 12.9716, 77.5946,
          'CREATED', 'WALLET'
        )
      `,
      /New ride requests may not use WALLET|23514|check_violation/,
      'New WALLET request insert must be rejected by DB trigger',
    );

    const requestCount = await db().client.rideRequest.count({
      where: { customerId: w.customer.userId },
    });
    assert.equal(requestCount, 0, 'No ride_request row must be created in DB');
  });

  it('1. Rejects new WALLET ride INSERT at DB level', async () => {
    const w = await rideWorld(app, { customer: '+919876690203', driver: '+919876690204' });
    const requestId = await bookRideRequest(app, w, { distanceKm: 5, paymentMethod: 'CARD' });

    await assert.rejects(
      db().client.$executeRaw`
        INSERT INTO "rides" (
          "id", "ride_code", "request_id", "customer_id", "driver_id", "vehicle_id", "vehicle_type_id",
          "pickup_location", "status", "payment_status", "payment_method"
        ) VALUES (
          gen_random_uuid(), 'RIDE-TEST-W1', ${requestId}::uuid, ${w.customer.userId}::uuid, ${w.driverId}::uuid, ${w.vehicleId}::uuid, ${w.vehicleTypeId}::uuid,
          ST_SetSRID(ST_MakePoint(77.5946, 12.9716), 4326), 'ACCEPTED', 'PENDING', 'WALLET'::"PaymentMethod"
        )
      `,
      /New rides may not use WALLET|23514|check_violation/,
      'New WALLET ride insert must be rejected by DB trigger',
    );

    const rideCount = await db().client.ride.count({ where: { customerId: w.customer.userId } });
    assert.equal(rideCount, 0, 'No ride row must be created');
  });

  // Requirement 2, 3, 4: New CASH, UPI, CARD requests and rides succeed
  it('2, 3, 4. Permits new CASH, UPI, and CARD requests and rides', async () => {
    const w = await rideWorld(app, { customer: '+919876690205', driver: '+919876690206' });

    for (const method of ['CASH', 'UPI', 'CARD'] as const) {
      await markDriverOnline(w.driverId);
      const requestId = await bookRideRequest(app, w, { distanceKm: 5, paymentMethod: method });
      const req = await db().client.rideRequest.findUniqueOrThrow({ where: { id: requestId } });
      assert.equal(req.paymentMethod, method);

      const rideId = await acceptRide(app, w, requestId);
      const ride = await db().client.ride.findUniqueOrThrow({ where: { id: rideId } });
      assert.equal(ride.paymentMethod, method);

      // Complete ride so the next iteration doesn't hit ACTIVE_RIDE_EXISTS
      await db().client
        .$executeRaw`UPDATE "rides" SET "status" = 'COMPLETED' WHERE "id" = ${rideId}::uuid`;
    }
  });

  // Requirement 5, 6, 7: Existing CASH, UPI, CARD → WALLET update is rejected
  it('5, 6, 7. Rejects updating an existing CASH/UPI/CARD request or ride to WALLET', async () => {
    const w = await rideWorld(app, { customer: '+919876690207', driver: '+919876690208' });

    for (const method of ['CASH', 'UPI', 'CARD'] as const) {
      await markDriverOnline(w.driverId);
      const requestId = await bookRideRequest(app, w, { distanceKm: 5, paymentMethod: method });
      const rideId = await acceptRide(app, w, requestId);

      // Attempt updating request payment_method to WALLET
      await assert.rejects(
        db().client.$executeRaw`
          UPDATE "ride_requests" SET "payment_method" = 'WALLET' WHERE "id" = ${requestId}::uuid
        `,
        /Cannot update payment_method to WALLET|23514|check_violation/,
        `Transitioning ${method} request to WALLET must be rejected`,
      );

      // Attempt updating ride payment_method to WALLET
      await assert.rejects(
        db().client.$executeRaw`
          UPDATE "rides" SET "payment_method" = 'WALLET'::"PaymentMethod" WHERE "id" = ${rideId}::uuid
        `,
        /Cannot update payment_method to WALLET|23514|check_violation/,
        `Transitioning ${method} ride to WALLET must be rejected`,
      );

      // Complete ride so the next iteration doesn't hit ACTIVE_RIDE_EXISTS
      await db().client
        .$executeRaw`UPDATE "rides" SET "status" = 'COMPLETED' WHERE "id" = ${rideId}::uuid`;
    }
  });

  // Requirement 8, 9, 10, 11: Historical WALLET rows can update status, payment_status, reach COMPLETED, and settle
  it('8, 9, 10, 11. Allows historical WALLET rides to update status, payment_status, reach COMPLETED, and settle', async () => {
    const w = await rideWorld(app, { customer: '+919876690209', driver: '+919876690210' });
    await fundWallet(app, w.customer, 5000);

    // Create a normal CARD ride first
    const requestId = await bookRideRequest(app, w, { distanceKm: 5, paymentMethod: 'CARD' });
    const rideId = await acceptRide(app, w, requestId);

    // Simulate a pre-existing historical WALLET ride by temporarily bypassing the trigger
    await db().client
      .$executeRaw`ALTER TABLE "rides" DISABLE TRIGGER "trg_check_no_new_wallet_ride"`;
    await db().client
      .$executeRaw`UPDATE "rides" SET "payment_method" = 'WALLET'::"PaymentMethod" WHERE "id" = ${rideId}::uuid`;
    await db().client
      .$executeRaw`ALTER TABLE "rides" ENABLE TRIGGER "trg_check_no_new_wallet_ride"`;

    let ride = await db().client.ride.findUniqueOrThrow({ where: { id: rideId } });
    assert.equal(ride.paymentMethod, 'WALLET', 'Ride is now a historical WALLET ride');

    // Req 8: Update status on historical WALLET row while DB trigger is active!
    await db().client.$executeRaw`
      UPDATE "rides" SET "status" = 'IN_PROGRESS' WHERE "id" = ${rideId}::uuid
    `;
    ride = await db().client.ride.findUniqueOrThrow({ where: { id: rideId } });
    assert.equal(ride.status, 'IN_PROGRESS');

    // Req 9 & 10: Update payment_status & status to COMPLETED while DB trigger is active!
    await db().client.$executeRaw`
      UPDATE "rides" SET "status" = 'COMPLETED', "payment_status" = 'PAID' WHERE "id" = ${rideId}::uuid
    `;
    ride = await db().client.ride.findUniqueOrThrow({ where: { id: rideId } });
    assert.equal(ride.status, 'COMPLETED');
    assert.equal(ride.paymentStatus, 'PAID');
    assert.equal(ride.paymentMethod, 'WALLET');

    // Req 11: Complete historical WALLET ride flow using lifecycle helpers and outbox drain
    const w2 = await rideWorld(app, { customer: '+919876690211', driver: '+919876690212' });
    await fundWallet(app, w2.customer, 5000);

    const { rideId: completedHistId } = await completeRide(app, w2, {
      distanceKm: 6,
      durationMin: 14,
      paymentMethod: 'WALLET',
    });
    await drainOutbox();

    const fullRide = await db().client.ride.findUniqueOrThrow({ where: { id: completedHistId } });
    assert.equal(fullRide.paymentMethod, 'WALLET');
    assert.equal(fullRide.paymentStatus, 'PAID');
    assert.equal(fullRide.status, 'COMPLETED');
  });
});

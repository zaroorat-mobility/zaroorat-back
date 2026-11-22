import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, bootEventConsumers, db, drainOutbox, resetState } from './helpers/harness.js';
import { makeDispatchOffer } from './helpers/fixtures.js';
import {
  acceptRide,
  bookRideRequest,
  completeRide,
  fundWallet,
  rideWorld,
  type RideWorld,
} from './helpers/ride-flow.js';
import { Decimal } from '../../src/modules/payments/types/index.js';
import type { Unsubscribe } from '../../src/core/events/index.js';

const REQUESTS = '/api/v1/rides/requests';

/// D1 — a NEW ride may only be CASH, UPI or CARD.
///
/// The customer pays the driver directly, and the customer wallet can no longer
/// be topped up, so a new WALLET ride could only ever spend a historical
/// balance. Rides booked BEFORE this rule keep working end to end: the enum,
/// the wallet, collection, receivables and write-off are all untouched.
describe('ride payment method — new rides (D1)', () => {
  let app: FastifyInstance;
  // Collection runs off the outbox, so the consumers have to be live for
  // `drainOutbox()` to settle a historical wallet ride.
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

  function book(world: RideWorld, paymentMethod: string) {
    return app.inject({
      method: 'POST',
      url: REQUESTS,
      headers: world.customer.authHeader,
      payload: {
        vehicleTypeId: world.vehicleTypeId,
        pickupLat: 12.9716,
        pickupLng: 77.5946,
        dropLat: 12.9716 + 5 * 0.009,
        dropLng: 77.5946,
        paymentMethod,
      },
    });
  }

  for (const method of ['CASH', 'UPI', 'CARD'] as const) {
    it(`accepts a new ${method} ride`, async () => {
      const w = await rideWorld(app, {
        customer: `+9198766911${method === 'CASH' ? '01' : method === 'UPI' ? '02' : '03'}`,
        driver: `+9198766912${method === 'CASH' ? '01' : method === 'UPI' ? '02' : '03'}`,
      });

      const response = await book(w, method);

      assert.equal(response.statusCode, 200, response.payload);
      const request = await db().client.rideRequest.findUniqueOrThrow({
        where: { id: response.json().data.id },
      });
      assert.equal(request.paymentMethod, method);

      // and it goes all the way through to a completed ride
      const rideId = await acceptRide(app, w, request.id);
      const ride = await db().client.ride.findUniqueOrThrow({ where: { id: rideId } });
      assert.equal(ride.paymentMethod, method);
    });
  }

  it('refuses a new WALLET ride, writes nothing, and touches no wallet balance', async () => {
    const w = await rideWorld(app, { customer: '+919876691104', driver: '+919876691204' });
    // A funded historical balance, so "no balance was touched" is a real claim.
    await fundWallet(app, w.customer, 2000);
    const before = await db().client.customerWallet.findUniqueOrThrow({
      where: { userId: w.customer.userId },
    });
    const txnsBefore = await db().client.customerWalletTransaction.count({
      where: { userId: w.customer.userId },
    });

    const response = await book(w, 'WALLET');

    assert.equal(response.statusCode, 400, response.payload);
    assert.equal(response.json().error.code, 'VALIDATION');

    assert.equal(
      await db().client.rideRequest.count({ where: { customerId: w.customer.userId } }),
      0,
      'no ride request was created',
    );
    assert.equal(
      await db().client.ride.count({ where: { customerId: w.customer.userId } }),
      0,
      'no ride was created',
    );
    const after = await db().client.customerWallet.findUniqueOrThrow({
      where: { userId: w.customer.userId },
    });
    assert.equal(after.balance.toFixed(2), before.balance.toFixed(2), 'balance untouched');
    assert.equal(after.lockedBalance.toFixed(2), before.lockedBalance.toFixed(2), 'nothing held');
    assert.equal(
      await db().client.customerWalletTransaction.count({ where: { userId: w.customer.userId } }),
      txnsBefore,
      'no wallet transaction was written',
    );
  });

  it('refuses to mint a ride from a WALLET request booked before the rule', async () => {
    const w = await rideWorld(app, { customer: '+919876691105', driver: '+919876691205' });
    // A request that predates D1: booked with a permitted method, then carrying
    // WALLET in the database exactly as an older row would.
    const requestId = await bookRideRequest(app, w, { distanceKm: 5, paymentMethod: 'CARD' });
    await db().client
      .$executeRaw`ALTER TABLE "ride_requests" DISABLE TRIGGER "trg_check_no_new_wallet_ride_request"`;
    await db().client
      .$executeRaw`UPDATE "ride_requests" SET "payment_method" = 'WALLET' WHERE "id" = ${requestId}::uuid`;
    await db().client
      .$executeRaw`ALTER TABLE "ride_requests" ENABLE TRIGGER "trg_check_no_new_wallet_ride_request"`;
    await makeDispatchOffer(requestId, w.driverId);

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/v1/rides/accept',
      headers: w.driver.authHeader,
      payload: { requestId, vehicleId: w.vehicleId },
    });

    assert.equal(accepted.statusCode, 422, accepted.payload);
    assert.equal(accepted.json().error.code, 'WALLET_RIDES_NOT_ACCEPTED');
    assert.equal(
      await db().client.ride.count({ where: { requestId } }),
      0,
      'no ride row was created',
    );
  });

  it('still completes and collects a historical WALLET ride', async () => {
    const w = await rideWorld(app, { customer: '+919876691106', driver: '+919876691206' });
    await fundWallet(app, w.customer, 3000);
    const before = await db().client.customerWallet.findUniqueOrThrow({
      where: { userId: w.customer.userId },
    });

    // `completeRide` with WALLET produces a historical ride — see its comment.
    const { rideId, fare } = await completeRide(app, w, {
      distanceKm: 6,
      durationMin: 14,
      paymentMethod: 'WALLET',
    });
    await drainOutbox();

    const ride = await db().client.ride.findUniqueOrThrow({ where: { id: rideId } });
    assert.equal(ride.paymentMethod, 'WALLET', 'the historical method is preserved');
    assert.equal(ride.paymentStatus, 'PAID', 'collection still settles it');

    const after = await db().client.customerWallet.findUniqueOrThrow({
      where: { userId: w.customer.userId },
    });
    assert.equal(
      after.balance.toFixed(2),
      new Decimal(before.balance).sub(fare.totalFare).toFixed(2),
      'the fare was collected from the historical wallet balance',
    );
    const attempt = await db().client.ridePayment.findFirstOrThrow({
      where: { rideId, status: 'SUCCEEDED' },
    });
    assert.equal(attempt.method, 'WALLET');
  });
});

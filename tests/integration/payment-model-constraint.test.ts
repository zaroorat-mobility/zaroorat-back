import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, resetState } from './helpers/harness.js';
import { completeRide, rideWorld } from './helpers/ride-flow.js';

/// Migration `20260917120000_payment_model_check`. A driver pays the platform
/// by SUBSCRIPTION or COMMISSION only; NULL stays allowed for now (a driver who
/// has not chosen yet, a ride from before the column existed).
describe('payment model CHECK constraints (integration)', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await bootApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(async () => {
    await resetState();
  });

  it('drivers.payment_model accepts SUBSCRIPTION, COMMISSION and NULL, and nothing else', async () => {
    const w = await rideWorld(app, { customer: '+919876690001', driver: '+919876690002' });

    for (const value of ['SUBSCRIPTION', 'COMMISSION', null]) {
      await db().client.$executeRaw`
        UPDATE "drivers" SET "payment_model" = ${value} WHERE "id" = ${w.driverId}::uuid`;
    }
    for (const value of ['WALLET', 'subscription', '']) {
      await assert.rejects(
        db().client.$executeRaw`
          UPDATE "drivers" SET "payment_model" = ${value} WHERE "id" = ${w.driverId}::uuid`,
        /drivers_payment_model_check/,
        value,
      );
    }
  });

  it('rides.driver_payment_model accepts SUBSCRIPTION, COMMISSION and a historical NULL, and nothing else', async () => {
    const w = await rideWorld(app, { customer: '+919876690003', driver: '+919876690004' });
    const { rideId } = await completeRide(app, w, { distanceKm: 5, durationMin: 12 });

    for (const value of ['SUBSCRIPTION', 'COMMISSION', null]) {
      await db().client.$executeRaw`
        UPDATE "rides" SET "driver_payment_model" = ${value} WHERE "id" = ${rideId}::uuid`;
    }
    const historical = await db().client.ride.findUniqueOrThrow({ where: { id: rideId } });
    assert.equal(historical.driverPaymentModel, null, 'a NULL ride stays readable');

    await assert.rejects(
      db().client.$executeRaw`
        UPDATE "rides" SET "driver_payment_model" = ${'LEGACY'} WHERE "id" = ${rideId}::uuid`,
      /rides_driver_payment_model_check/,
    );
  });
});

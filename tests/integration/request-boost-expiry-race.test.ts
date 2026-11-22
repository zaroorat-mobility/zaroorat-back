import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { rideWorld } from './helpers/ride-flow.js';
import {
  makeActiveSubscription,
  makeAssignedVehicle,
  makeDispatchOffer,
  makeDriver,
  markDriverOnline,
} from './helpers/fixtures.js';
import { container } from '../../src/core/di.js';
import type { RequestExpiryJob } from '../../src/modules/rides/jobs/request-expiry.job.js';
import type { RideDispatchRepository } from '../../src/modules/rides/repositories/ride-dispatch.repository.js';
import type { DispatchTimeoutJob } from '../../src/modules/rides/jobs/dispatch-timeout.job.js';

const TRIP = {
  pickupLat: 12.9716,
  pickupLng: 77.5946,
  dropLat: 12.9352,
  dropLng: 77.6245,
};

describe('request boost, expiry, and counter semantics (integration)', () => {
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

  async function createExtraDriver(phone: string, vehicleTypeId: string) {
    const user = await loginAs(app, phone);
    const driverId = await makeDriver(user.userId, {
      verified: true,
      paymentModel: 'SUBSCRIPTION',
    });
    await makeActiveSubscription(driverId);
    const { vehicleId } = await makeAssignedVehicle(driverId, { vehicleTypeId, verified: true });
    await markDriverOnline(driverId);
    return { user, driverId, vehicleId };
  }

  it('accurately counts notified and passed, excluding offers cancelled by another driver acceptance', async () => {
    const world = await rideWorld(app, {
      customer: '+919876540201',
      driver: '+919876540202',
    });

    const driver2 = await createExtraDriver('+919876540203', world.vehicleTypeId);
    const driver3 = await createExtraDriver('+919876540204', world.vehicleTypeId);

    // Create ride request
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/rides/requests',
      headers: world.customer.authHeader,
      payload: { vehicleTypeId: world.vehicleTypeId, ...TRIP, boostAmount: 0 },
    });
    assert.equal(createRes.statusCode, 200);
    const requestId = createRes.json().data.id as string;

    const dispatchRepo = container.resolve<RideDispatchRepository>('rideDispatchRepository');

    // 1. Dispatch offer to driver 1 and driver 2
    const offer1Id = await makeDispatchOffer(requestId, world.driverId);
    const offer2Id = await makeDispatchOffer(requestId, driver2.driverId);

    let stats = await dispatchRepo.countOfferStatsForRequest(requestId);
    assert.equal(stats.driversNotified, 2);
    assert.equal(stats.driversRejected, 0);

    // 2. Driver 1 explicitly rejects
    const rejectRes = await app.inject({
      method: 'POST',
      url: `/api/v1/rides/offers/${offer1Id}/reject`,
      headers: world.driver.authHeader,
      payload: { reason: 'Too far' },
    });
    assert.equal(rejectRes.statusCode, 200);

    stats = await dispatchRepo.countOfferStatsForRequest(requestId);
    assert.equal(stats.driversNotified, 2);
    assert.equal(stats.driversRejected, 1, 'Driver 1 rejection counts as Passed');

    // 3. Driver 2 offer expires / times out
    await db().client.rideDispatch.update({
      where: { id: offer2Id },
      data: { expiresAt: new Date(Date.now() - 10_000) },
    });
    const timeoutJob = container.resolve<DispatchTimeoutJob>('dispatchTimeoutJob');
    await timeoutJob.run();

    stats = await dispatchRepo.countOfferStatsForRequest(requestId);
    assert.equal(stats.driversNotified, 2);
    assert.equal(stats.driversRejected, 2, 'Offer timeout also counts as Passed');

    // 4. Driver 3 is offered and accepts the ride
    await makeDispatchOffer(requestId, driver3.driverId);
    const acceptRes = await app.inject({
      method: 'POST',
      url: '/api/v1/rides/accept',
      headers: driver3.user.authHeader,
      payload: { requestId, vehicleId: driver3.vehicleId },
    });
    assert.equal(acceptRes.statusCode, 200);

    // Cancel remaining pending offers simulate another driver winning
    await dispatchRepo.cancelAllPendingForRequest(requestId);

    // Stats check: CANCELLED offers are excluded
    stats = await dispatchRepo.countOfferStatsForRequest(requestId);
    assert.equal(stats.driversRejected, 2, 'Cancelled offers are excluded from Passed');
  });

  it('boost extends expiresAt and prevents an old expiry job from expiring the request', async () => {
    const world = await rideWorld(app, {
      customer: '+919876540205',
      driver: '+919876540206',
    });

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/rides/requests',
      headers: world.customer.authHeader,
      payload: { vehicleTypeId: world.vehicleTypeId, ...TRIP, boostAmount: 0 },
    });
    assert.equal(createRes.statusCode, 200);
    const requestId = createRes.json().data.id as string;

    // Simulate request about to expire at threshold T
    const staleExpiry = new Date(Date.now() - 1000);
    await db().client.rideRequest.update({
      where: { id: requestId },
      data: { expiresAt: staleExpiry },
    });

    // Customer boosts the request!
    const boostRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/rides/requests/${requestId}/boost`,
      headers: world.customer.authHeader,
      payload: { boostAmount: 20 },
    });
    assert.equal(boostRes.statusCode, 200);
    const boosted = boostRes.json().data;
    assert.equal(boosted.boostAmount, 20);

    // The request now has an extended expiresAt (in the future)
    const freshRequest = await db().client.rideRequest.findUniqueOrThrow({
      where: { id: requestId },
    });
    assert.ok(freshRequest.expiresAt!.getTime() > Date.now());

    // An expiry job that was running with the stale threshold runs
    const expiryJob = container.resolve<RequestExpiryJob>('requestExpiryJob');
    const expiredCount = await expiryJob.run();
    assert.equal(expiredCount, 0, 'Newly boosted request must not be expired by expiry job');

    // Active request is still searchable
    const activeRes = await app.inject({
      method: 'GET',
      url: '/api/v1/rides/requests/active',
      headers: world.customer.authHeader,
    });
    assert.equal(activeRes.statusCode, 200);
    assert.equal(activeRes.json().data.id, requestId);
    assert.equal(activeRes.json().data.boostAmount, 20);
  });

  it('already-expired request cannot be boosted or returned in active search', async () => {
    const world = await rideWorld(app, {
      customer: '+919876540207',
      driver: '+919876540208',
    });

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/rides/requests',
      headers: world.customer.authHeader,
      payload: { vehicleTypeId: world.vehicleTypeId, ...TRIP, boostAmount: 0 },
    });
    assert.equal(createRes.statusCode, 200);
    const requestId = createRes.json().data.id as string;

    // Expire the request
    await db().client.rideRequest.update({
      where: { id: requestId },
      data: { status: 'EXPIRED', expiresAt: new Date(Date.now() - 5000) },
    });

    // 1. GET /rides/requests/active returns null immediately
    const activeRes = await app.inject({
      method: 'GET',
      url: '/api/v1/rides/requests/active',
      headers: world.customer.authHeader,
    });
    assert.equal(activeRes.statusCode, 200);
    assert.equal(activeRes.json().data, null);

    // 2. Attempting to boost an expired request is rejected
    const boostRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/rides/requests/${requestId}/boost`,
      headers: world.customer.authHeader,
      payload: { boostAmount: 20 },
    });
    assert.ok(boostRes.statusCode >= 400);

    // 3. GET /rides/requests/:id shows EXPIRED status
    const byIdRes = await app.inject({
      method: 'GET',
      url: `/api/v1/rides/requests/${requestId}`,
      headers: world.customer.authHeader,
    });
    assert.equal(byIdRes.statusCode, 200);
    assert.equal(byIdRes.json().data.status, 'EXPIRED');
  });
});

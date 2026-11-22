import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, resetState } from './helpers/harness.js';
import { rideWorld } from './helpers/ride-flow.js';
import { RIDE_PIN, makeDispatchOffer } from './helpers/fixtures.js';
import { container } from '../../src/core/di.js';
import type { DriverLocationRepository } from '../../src/modules/drivers/repositories/driver-location.repository.js';

const TRIP = {
  pickupLat: 12.9716,
  pickupLng: 77.5946,
  dropLat: 12.9352,
  dropLng: 77.6245,
};

describe('customer ride and request normalized contracts (integration)', () => {
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

  async function seedDriverLocation(driverId: string, lat: number, lng: number) {
    const repo = container.resolve<DriverLocationRepository>('driverLocationRepository');
    await repo.updateLocation({
      driverId,
      latitude: lat,
      longitude: lng,
      heading: 0,
    });
  }

  it('preserves identical normalized request shapes across create, boost, and get queries', async () => {
    const world = await rideWorld(app, {
      customer: '+919876540111',
      driver: '+919876540112',
    });

    // 1. Create request with initial boost
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/rides/requests',
      headers: world.customer.authHeader,
      payload: {
        vehicleTypeId: world.vehicleTypeId,
        ...TRIP,
        pickupAddress: 'MG Road Metro',
        dropAddress: 'Koramangala 5th Block',
        paymentMethod: 'CASH',
        boostAmount: 0,
      },
    });
    assert.equal(createRes.statusCode, 200, createRes.payload);
    const created = createRes.json().data;

    // Verify fields on created request
    assert.ok(created.id);
    assert.equal(created.customerId, world.customer.userId);
    assert.equal(created.status, 'CREATED');
    assert.equal(typeof created.pickupLat, 'number');
    assert.equal(typeof created.pickupLng, 'number');
    assert.equal(typeof created.dropLat, 'number');
    assert.equal(typeof created.dropLng, 'number');
    assert.equal(typeof created.quotedFare, 'number');
    assert.equal(created.boostAmount, 0);
    assert.equal(created.totalOffered, created.quotedFare);
    assert.equal(created.pickupAddress, 'MG Road Metro');
    assert.equal(created.dropAddress, 'Koramangala 5th Block');
    assert.equal(created.paymentMethod, 'CASH');
    assert.ok(created.vehicleType);
    assert.equal(created.vehicleType.id, world.vehicleTypeId);
    assert.equal(typeof created.vehicleType.name, 'string');
    assert.equal(typeof created.vehicleType.code, 'string');

    // 2. GET /rides/requests/active matches created exactly
    const activeRes = await app.inject({
      method: 'GET',
      url: '/api/v1/rides/requests/active',
      headers: world.customer.authHeader,
    });
    assert.equal(activeRes.statusCode, 200, activeRes.payload);
    const active = activeRes.json().data;
    assert.deepEqual(created, active);

    // 3. GET /rides/requests/:id matches created exactly
    const byIdRes = await app.inject({
      method: 'GET',
      url: `/api/v1/rides/requests/${created.id}`,
      headers: world.customer.authHeader,
    });
    assert.equal(byIdRes.statusCode, 200, byIdRes.payload);
    const byId = byIdRes.json().data;
    assert.deepEqual(created, byId);

    // 4. Boost validation: reject invalid boostAmount
    const invalidBoostRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/rides/requests/${created.id}/boost`,
      headers: world.customer.authHeader,
      payload: { boostAmount: 999 },
    });
    assert.equal(invalidBoostRes.statusCode, 400);

    // 5. Valid boost: boostAmount 20 (testing PATCH)
    const boostRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/rides/requests/${created.id}/boost`,
      headers: world.customer.authHeader,
      payload: { boostAmount: 20 },
    });
    assert.equal(boostRes.statusCode, 200, boostRes.payload);
    const boosted = boostRes.json().data;
    assert.equal(boosted.id, created.id);
    assert.equal(boosted.boostAmount, 20);
    assert.equal(boosted.totalOffered, created.quotedFare + 20);

    // 6. GET /rides/requests/active matches boosted response
    const activeAfterBoost = await app.inject({
      method: 'GET',
      url: '/api/v1/rides/requests/active',
      headers: world.customer.authHeader,
    });
    assert.equal(activeAfterBoost.statusCode, 200);
    assert.deepEqual(boosted, activeAfterBoost.json().data);

    // 7. GET /rides/requests/:id matches boosted response
    const byIdAfterBoost = await app.inject({
      method: 'GET',
      url: `/api/v1/rides/requests/${created.id}`,
      headers: world.customer.authHeader,
    });
    assert.equal(byIdAfterBoost.statusCode, 200);
    assert.deepEqual(boosted, byIdAfterBoost.json().data);

    // 8. Test POST alias for boost works identically
    const boostPostRes = await app.inject({
      method: 'POST',
      url: `/api/v1/rides/requests/${created.id}/boost`,
      headers: world.customer.authHeader,
      payload: { boostAmount: 30 },
    });
    assert.equal(boostPostRes.statusCode, 200);
    assert.equal(boostPostRes.json().data.boostAmount, 30);
  });

  it('preserves normalized ride shape across accept, arrive, start, complete, and detail queries', async () => {
    const world = await rideWorld(app, {
      customer: '+919876540113',
      driver: '+919876540114',
    });

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/rides/requests',
      headers: world.customer.authHeader,
      payload: {
        vehicleTypeId: world.vehicleTypeId,
        ...TRIP,
        pickupAddress: 'Indiranagar 100ft Rd',
        dropAddress: 'HSR Layout Sector 1',
        paymentMethod: 'CASH',
        boostAmount: 30,
      },
    });
    assert.equal(createRes.statusCode, 200);
    const requestId = createRes.json().data.id as string;
    const expectedQuotedFare = createRes.json().data.quotedFare as number;

    await makeDispatchOffer(requestId, world.driverId);

    // Driver accepts
    const acceptRes = await app.inject({
      method: 'POST',
      url: '/api/v1/rides/accept',
      headers: world.driver.authHeader,
      payload: { requestId, vehicleId: world.vehicleId },
    });
    assert.equal(acceptRes.statusCode, 200, acceptRes.payload);
    const rideId = acceptRes.json().data.ride.id as string;

    // Verify GET /rides/:id for customer
    const getRes1 = await app.inject({
      method: 'GET',
      url: `/api/v1/rides/${rideId}`,
      headers: world.customer.authHeader,
    });
    assert.equal(getRes1.statusCode, 200, getRes1.payload);
    const rideView1 = getRes1.json().data;

    assert.equal(rideView1.id, rideId);
    assert.equal(rideView1.status, 'ACCEPTED');
    assert.equal(rideView1.quotedFare, expectedQuotedFare);
    assert.equal(rideView1.boostAmount, 30);
    assert.equal(rideView1.totalOffered, expectedQuotedFare + 30);
    assert.equal(typeof rideView1.pickupLat, 'number');
    assert.equal(typeof rideView1.pickupLng, 'number');
    assert.equal(typeof rideView1.dropLat, 'number');
    assert.equal(typeof rideView1.dropLng, 'number');
    assert.ok(rideView1.vehicle);
    assert.equal(rideView1.vehicle.id, world.vehicleId);
    assert.ok(rideView1.vehicleType);
    assert.ok(rideView1.driver);
    assert.ok(rideView1.customer);

    // GET /rides/active returns the same normalized shape
    const activeRes1 = await app.inject({
      method: 'GET',
      url: '/api/v1/rides/active',
      headers: world.customer.authHeader,
    });
    assert.equal(activeRes1.statusCode, 200, activeRes1.payload);
    assert.deepEqual(rideView1, activeRes1.json().data);

    // Place driver at pickup location before arriving
    await seedDriverLocation(world.driverId, TRIP.pickupLat, TRIP.pickupLng);

    // Driver marks arriving
    const arrivingRes = await app.inject({
      method: 'POST',
      url: `/api/v1/rides/${rideId}/arriving`,
      headers: world.driver.authHeader,
      payload: {},
    });
    assert.equal(arrivingRes.statusCode, 200, arrivingRes.payload);
    const arrivingRide = arrivingRes.json().data;
    assert.equal(arrivingRide.status, 'DRIVER_ARRIVING');

    // Driver arrives at pickup
    const arriveRes = await app.inject({
      method: 'POST',
      url: `/api/v1/rides/${rideId}/arrive`,
      headers: world.driver.authHeader,
      payload: {},
    });
    assert.equal(arriveRes.statusCode, 200, arriveRes.payload);
    const arriveRide = arriveRes.json().data;
    assert.equal(arriveRide.status, 'DRIVER_ARRIVED');

    const getRes2 = await app.inject({
      method: 'GET',
      url: `/api/v1/rides/${rideId}`,
      headers: world.customer.authHeader,
    });
    assert.deepEqual(arriveRide, getRes2.json().data);

    // Driver starts ride
    const startRes = await app.inject({
      method: 'POST',
      url: `/api/v1/rides/${rideId}/start`,
      headers: world.driver.authHeader,
      payload: { pin: RIDE_PIN },
    });
    assert.equal(startRes.statusCode, 200, startRes.payload);
    const startRide = startRes.json().data;
    assert.equal(startRide.status, 'IN_PROGRESS');
    assert.equal(startRide.quotedFare, expectedQuotedFare);
    assert.equal(startRide.boostAmount, 30);
    assert.equal(startRide.totalOffered, expectedQuotedFare + 30);

    const getRes3 = await app.inject({
      method: 'GET',
      url: `/api/v1/rides/${rideId}`,
      headers: world.customer.authHeader,
    });
    assert.deepEqual(startRide, getRes3.json().data);

    // Place driver at drop location before completing
    await seedDriverLocation(world.driverId, TRIP.dropLat, TRIP.dropLng);

    // Driver completes ride
    const completeRes = await app.inject({
      method: 'POST',
      url: `/api/v1/rides/${rideId}/complete`,
      headers: world.driver.authHeader,
      payload: { actualDistanceKm: 6.5, actualDurationMin: 18 },
    });
    assert.equal(completeRes.statusCode, 200, completeRes.payload);
    const completeRide = completeRes.json().data;
    assert.equal(completeRide.status, 'COMPLETED');
    assert.ok(completeRide.fare);
    assert.equal(typeof completeRide.fare.totalFare, 'number');
    assert.ok(completeRide.fare.totalFare > 0);

    const getRes4 = await app.inject({
      method: 'GET',
      url: `/api/v1/rides/${rideId}`,
      headers: world.customer.authHeader,
    });
    assert.deepEqual(completeRide, getRes4.json().data);
  });

  it('preserves normalized ride shape on cancellation', async () => {
    const world = await rideWorld(app, {
      customer: '+919876540115',
      driver: '+919876540116',
    });

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/rides/requests',
      headers: world.customer.authHeader,
      payload: {
        vehicleTypeId: world.vehicleTypeId,
        ...TRIP,
        paymentMethod: 'CASH',
        boostAmount: 0,
      },
    });
    const requestId = createRes.json().data.id as string;
    await makeDispatchOffer(requestId, world.driverId);

    const acceptRes = await app.inject({
      method: 'POST',
      url: '/api/v1/rides/accept',
      headers: world.driver.authHeader,
      payload: { requestId, vehicleId: world.vehicleId },
    });
    const rideId = acceptRes.json().data.ride.id as string;

    // Customer cancels
    const cancelRes = await app.inject({
      method: 'POST',
      url: `/api/v1/rides/${rideId}/cancel`,
      headers: world.customer.authHeader,
      payload: { reasonCode: 'CHANGED_PLANS', reasonText: 'Change of mind' },
    });
    assert.equal(cancelRes.statusCode, 200, cancelRes.payload);
    const cancelledRide = cancelRes.json().data;
    assert.equal(cancelledRide.status, 'CANCELLED_BY_CUSTOMER');

    const getRes = await app.inject({
      method: 'GET',
      url: `/api/v1/rides/${rideId}`,
      headers: world.customer.authHeader,
    });
    assert.deepEqual(cancelledRide, getRes.json().data);
  });
});

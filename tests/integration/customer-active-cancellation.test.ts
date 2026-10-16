import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { rideWorld } from './helpers/ride-flow.js';
import { RIDE_PIN, makeDispatchOffer } from './helpers/fixtures.js';
import { rideConfig } from '../../src/config/ride/ride.config.js';
import { container } from '../../src/core/di.js';
import type { DriverLocationRepository } from '../../src/modules/drivers/repositories/driver-location.repository.js';

const TRIP = {
  pickupLat: 12.9716,
  pickupLng: 77.5946,
  dropLat: 12.9352,
  dropLng: 77.6245,
};

describe('Customer cancellation during an active trip (integration)', () => {
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

  async function setupStartedRide() {
    const world = await rideWorld(app, {
      customer: '+919876540211',
      driver: '+919876540212',
    });

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/rides/requests',
      headers: world.customer.authHeader,
      payload: {
        vehicleTypeId: world.vehicleTypeId,
        paymentMethod: 'CASH',
        boostAmount: 0,
        ...TRIP,
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

    // Seed location right at pickup and arrive
    await seedDriverLocation(world.driverId, TRIP.pickupLat, TRIP.pickupLng);
    const arriveRes = await app.inject({
      method: 'POST',
      url: `/api/v1/rides/${rideId}/arrive`,
      headers: world.driver.authHeader,
    });
    assert.equal(arriveRes.statusCode, 200, arriveRes.payload);

    // Driver starts trip with PIN
    const startRes = await app.inject({
      method: 'POST',
      url: `/api/v1/rides/${rideId}/start`,
      headers: world.driver.authHeader,
      payload: { pin: RIDE_PIN },
    });
    assert.equal(startRes.statusCode, 200, startRes.payload);
    assert.equal(startRes.json().data.status, 'IN_PROGRESS');

    return { world, rideId };
  }

  it('requires a non-empty reason to cancel', async () => {
    const { world, rideId } = await setupStartedRide();

    const emptyReasonRes = await app.inject({
      method: 'POST',
      url: `/api/v1/rides/${rideId}/cancel`,
      headers: world.customer.authHeader,
      payload: { reasonCode: '' },
    });
    assert.equal(emptyReasonRes.statusCode, 400);

    const noReasonRes = await app.inject({
      method: 'POST',
      url: `/api/v1/rides/${rideId}/cancel`,
      headers: world.customer.authHeader,
      payload: {},
    });
    assert.equal(noReasonRes.statusCode, 400);
  });

  it('cancels an IN_PROGRESS ride atomically and assesses cancellation fee', async () => {
    const { world, rideId } = await setupStartedRide();

    // Fast-forward acceptedAt past grace period
    await db().client.ride.update({
      where: { id: rideId },
      data: {
        acceptedAt: new Date(Date.now() - (rideConfig.cancellationGraceMinutes + 2) * 60_000),
      },
    });

    const cancelRes = await app.inject({
      method: 'POST',
      url: `/api/v1/rides/${rideId}/cancel`,
      headers: world.customer.authHeader,
      payload: {
        reasonCode: 'CUSTOMER_EMERGENCY',
        reasonText: 'Personal emergency, please stop',
      },
    });

    assert.equal(cancelRes.statusCode, 200, cancelRes.payload);
    const body = cancelRes.json().data;
    assert.equal(body.status, 'CANCELLED_BY_CUSTOMER');
    assert.ok(body.cancellation);
    assert.equal(body.cancellation.reasonCode, 'CUSTOMER_EMERGENCY');
    assert.equal(body.cancellation.cancelledAtStatus, 'IN_PROGRESS');
    assert.equal(Number(body.cancellation.cancellationFee), rideConfig.defaultCancellationFee);
    assert.equal(body.cancellation.feeCharged, false);

    // Verify driver status is freed back to ONLINE
    const driverStatus = await db().client.driverOnlineStatus.findUnique({
      where: { driverId: world.driverId },
    });
    assert.equal(driverStatus?.status, 'ONLINE');
  });

  it('rejects duplicate cancellation or unauthorized cancellation deterministically', async () => {
    const { world, rideId } = await setupStartedRide();

    // Unauthorized outsider attempts cancellation
    const intruder = await loginAs(app, '+919876540999');
    const unauthorizedRes = await app.inject({
      method: 'POST',
      url: `/api/v1/rides/${rideId}/cancel`,
      headers: intruder.authHeader,
      payload: { reasonCode: 'OTHER' },
    });
    assert.equal(unauthorizedRes.statusCode, 403);

    // First valid cancellation succeeds
    const firstCancel = await app.inject({
      method: 'POST',
      url: `/api/v1/rides/${rideId}/cancel`,
      headers: world.customer.authHeader,
      payload: { reasonCode: 'CHANGED_PLANS' },
    });
    assert.equal(firstCancel.statusCode, 200);

    // Duplicate cancellation fails with 409
    const secondCancel = await app.inject({
      method: 'POST',
      url: `/api/v1/rides/${rideId}/cancel`,
      headers: world.customer.authHeader,
      payload: { reasonCode: 'CHANGED_PLANS' },
    });
    assert.equal(secondCancel.statusCode, 409);
  });
});

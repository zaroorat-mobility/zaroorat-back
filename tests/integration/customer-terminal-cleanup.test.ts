import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, bootEventConsumers, resetState, drainOutbox } from './helpers/harness.js';
import type { Unsubscribe } from '@core/events';
import { rideWorld, bookRideRequest, acceptRide } from './helpers/ride-flow.js';
import { RIDE_PIN } from './helpers/fixtures.js';
import { container } from '../../src/core/di.js';
import type { DriverLocationRepository } from '../../src/modules/drivers/repositories/driver-location.repository.js';
import type { RealtimeGateway } from '../../src/modules/realtime/realtime.gateway.js';
import type { SocketEnvelope } from '../../src/modules/realtime/events.js';

const TRIP = {
  pickupLat: 12.9716,
  pickupLng: 77.5946,
  dropLat: 12.9352,
  dropLng: 77.6245,
};

describe('customer terminal ride cleanup (integration)', () => {
  let app: FastifyInstance;
  let teardownConsumers: Unsubscribe;

  before(async () => {
    app = await bootApp();
    teardownConsumers = bootEventConsumers();
  });
  after(async () => {
    teardownConsumers();
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

  it('ensures completed ride returns normalized view, clears active ride to null, and emits socket event', async () => {
    const world = await rideWorld(app, {
      customer: '+919876540301',
      driver: '+919876540302',
    });

    const emittedEvents: Array<{
      rooms: string | string[];
      event: string;
      payload: Record<string, unknown>;
    }> = [];
    const gateway = container.resolve<RealtimeGateway>('realtimeGateway');
    const origEmit = gateway.emitToRoom;
    gateway.emitToRoom = function (rooms: string | string[], envelope: SocketEnvelope) {
      emittedEvents.push({
        rooms,
        event: envelope.type,
        payload: envelope.data as Record<string, unknown>,
      });
      return origEmit.call(this, rooms, envelope);
    };

    try {
      // 1. Book and accept
      const reqId = await bookRideRequest(app, world, { distanceKm: 2 });
      const rideId = await acceptRide(app, world, reqId);

      // Verify active ride is present during trip
      const activeBeforeRes = await app.inject({
        method: 'GET',
        url: '/api/v1/rides/active',
        headers: world.customer.authHeader,
      });
      assert.equal(activeBeforeRes.statusCode, 200);
      assert.equal(activeBeforeRes.json().data?.id, rideId);
      assert.equal(activeBeforeRes.json().data?.status, 'ACCEPTED');

      // 2. Arrive and start
      await seedDriverLocation(world.driverId, TRIP.pickupLat, TRIP.pickupLng);
      await app.inject({
        method: 'POST',
        url: `/api/v1/rides/${rideId}/arrive`,
        headers: world.driver.authHeader,
        payload: {},
      });
      await app.inject({
        method: 'POST',
        url: `/api/v1/rides/${rideId}/start`,
        headers: world.driver.authHeader,
        payload: { pin: RIDE_PIN },
      });

      // 3. Complete
      const dropLat = 12.9716 + 2 * 0.009;
      await seedDriverLocation(world.driverId, dropLat, TRIP.pickupLng);
      const completeRes = await app.inject({
        method: 'POST',
        url: `/api/v1/rides/${rideId}/complete`,
        headers: world.driver.authHeader,
        payload: { actualDistanceKm: 2, actualDurationMin: 5 },
      });
      assert.equal(completeRes.statusCode, 200);
      const completedRide = completeRes.json().data;
      assert.equal(completedRide.id, rideId);
      assert.equal(completedRide.status, 'COMPLETED');
      assert.ok(
        completedRide.fare?.totalFare != null,
        'Completed ride view must contain fare.totalFare',
      );

      // 4. Drain outbox to process socket emit
      await drainOutbox();

      const completedSocket = emittedEvents.find((e) => e.event === 'ride.completed');
      assert.ok(completedSocket, 'ride.completed socket event must be emitted');
      assert.equal(completedSocket.payload.rideId, rideId);
      assert.equal(completedSocket.payload.status, 'COMPLETED');
      assert.ok(completedSocket.payload.totalFare != null, 'Socket payload must contain totalFare');

      // 5. Active ride must now be null for both customer and driver
      const activeCustomerRes = await app.inject({
        method: 'GET',
        url: '/api/v1/rides/active',
        headers: world.customer.authHeader,
      });
      assert.equal(activeCustomerRes.statusCode, 200);
      assert.equal(
        activeCustomerRes.json().data,
        null,
        'Active ride for customer must be null after completion',
      );

      const activeDriverRes = await app.inject({
        method: 'GET',
        url: '/api/v1/rides/active',
        headers: world.driver.authHeader,
      });
      assert.equal(activeDriverRes.statusCode, 200);
      assert.equal(
        activeDriverRes.json().data,
        null,
        'Active ride for driver must be null after completion',
      );

      // 6. Direct GET by ID returns normalized terminal ride
      const getByIdRes = await app.inject({
        method: 'GET',
        url: `/api/v1/rides/${rideId}`,
        headers: world.customer.authHeader,
      });
      assert.equal(getByIdRes.statusCode, 200);
      assert.equal(getByIdRes.json().data.id, rideId);
      assert.equal(getByIdRes.json().data.status, 'COMPLETED');
    } finally {
      gateway.emitToRoom = origEmit;
    }
  });

  it('ensures cancelled ride returns normalized view, clears active ride to null, and emits socket event', async () => {
    const world = await rideWorld(app, {
      customer: '+919876540303',
      driver: '+919876540304',
    });

    const emittedEvents: Array<{
      rooms: string | string[];
      event: string;
      payload: Record<string, unknown>;
    }> = [];
    const gateway = container.resolve<RealtimeGateway>('realtimeGateway');
    const origEmit = gateway.emitToRoom;
    gateway.emitToRoom = function (rooms: string | string[], envelope: SocketEnvelope) {
      emittedEvents.push({
        rooms,
        event: envelope.type,
        payload: envelope.data as Record<string, unknown>,
      });
      return origEmit.call(this, rooms, envelope);
    };

    try {
      // 1. Book and accept
      const reqId = await bookRideRequest(app, world, { distanceKm: 2 });
      const rideId = await acceptRide(app, world, reqId);

      // 2. Cancel by customer
      const cancelRes = await app.inject({
        method: 'POST',
        url: `/api/v1/rides/${rideId}/cancel`,
        headers: world.customer.authHeader,
        payload: { reasonCode: 'CHANGED_MY_MIND', reasonText: 'No longer needed' },
      });
      assert.equal(cancelRes.statusCode, 200);
      const cancelledRide = cancelRes.json().data;
      assert.equal(cancelledRide.id, rideId);
      assert.equal(cancelledRide.status, 'CANCELLED_BY_CUSTOMER');

      // 3. Drain outbox
      await drainOutbox();

      const cancelledSocket = emittedEvents.find((e) => e.event === 'ride.cancelled');
      assert.ok(cancelledSocket, 'ride.cancelled socket event must be emitted');
      assert.equal(cancelledSocket.payload.rideId, rideId);
      assert.equal(cancelledSocket.payload.status, 'CANCELLED_BY_CUSTOMER');
      assert.equal(cancelledSocket.payload.cancelledBy, 'CUSTOMER');

      // 4. GET /rides/active returns null
      const activeCustomerRes = await app.inject({
        method: 'GET',
        url: '/api/v1/rides/active',
        headers: world.customer.authHeader,
      });
      assert.equal(activeCustomerRes.statusCode, 200);
      assert.equal(activeCustomerRes.json().data, null);
    } finally {
      gateway.emitToRoom = origEmit;
    }
  });
});

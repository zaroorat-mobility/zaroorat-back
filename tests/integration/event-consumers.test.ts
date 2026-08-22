import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import {
  bootApp,
  bootEventConsumers,
  db,
  drainOutbox,
  loginAs,
  resetState,
} from './helpers/harness.js';
import { grantRole, makeAssignedVehicle, makeDriver, makeVehicleType } from './helpers/fixtures.js';
import { container } from '../../src/core/di.js';
import type { EventBus, Unsubscribe } from '../../src/core/events/index.js';
import type { EventPublisher } from '../../src/core/events/index.js';

const CENTRE = { latitude: 12.9716, longitude: 77.5946 };

/// Proves the bootstrap boundary works: the real consumers can be registered in
/// a test process, a published event reaches them, and they do their work — all
/// without starting the outbox relay's timer, an HTTP listener, or a BullMQ
/// worker.
describe('event consumer registration and delivery (integration)', () => {
  let app: FastifyInstance;
  let unsubscribe: Unsubscribe;

  before(async () => {
    app = await bootApp();
    unsubscribe = bootEventConsumers();
  });
  after(async () => {
    unsubscribe();
    await app.close();
  });
  afterEach(async () => {
    await resetState();
  });

  function bus(): EventBus {
    return container.resolve<EventBus>('eventBus');
  }

  describe('the bootstrap boundary', () => {
    it('subscribes every production consumer to the bus', () => {
      // If a consumer is added to CONSUMER_KEYS but never registers, or a new
      // ride event has no listener, this is what notices.
      for (const type of [
        'ride.requested',
        'ride.dispatch.offered',
        'ride.accepted',
        'ride.driver_arriving',
        'ride.driver_arrived',
        'ride.completed',
        'ride.cancelled',
        'driver.verified',
      ]) {
        assert.ok(bus().listenerCount(type) > 0, `nothing is listening to ${type}`);
      }
    });

    it('starts no relay of its own — the test drives delivery', async () => {
      const customer = await loginAs(app, '+919876760001');
      await app.inject({
        method: 'PATCH',
        url: '/api/v1/users/me/profile',
        headers: customer.authHeader,
        payload: { firstName: 'Cat', lastName: 'Customer' },
      });

      const before = await db().client.outboxEvent.count({ where: { status: 'PENDING' } });
      assert.ok(before > 0, 'events are sitting on the outbox');
      // A running relay would have drained these on its own by now. They are
      // still PENDING, which is the proof that registration started no timer.
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(await db().client.outboxEvent.count({ where: { status: 'PENDING' } }), before);

      assert.ok((await drainOutbox()) >= before, 'draining by hand publishes them');
      assert.equal(await db().client.outboxEvent.count({ where: { status: 'PENDING' } }), 0);
    });

    it('unsubscribes cleanly so suites cannot leak listeners into each other', () => {
      const localUnsubscribe = bootEventConsumers();
      const doubled = bus().listenerCount('ride.requested');
      localUnsubscribe();
      assert.ok(
        bus().listenerCount('ride.requested') < doubled,
        'the handle must actually remove what it added',
      );
      assert.ok(bus().listenerCount('ride.requested') > 0, 'and leave the outer suite intact');
    });
  });

  describe('a published event reaches its consumer and it acts', () => {
    it('dispatches a ride request through the registered consumer', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `EC_${randomUUID().slice(0, 6)}` });

      const seed = await loginAs(app, '+919876760002');
      await grantRole(seed.userId, 'driver');
      const driverUser = await loginAs(app, '+919876760002');
      const driverId = await makeDriver(driverUser.userId, { verified: true });
      await makeAssignedVehicle(driverId, { vehicleTypeId });
      await app.inject({
        method: 'POST',
        url: '/api/v1/drivers/status/online',
        headers: driverUser.authHeader,
        payload: {},
      });
      await app.inject({
        method: 'POST',
        url: '/api/v1/drivers/location',
        headers: driverUser.authHeader,
        payload: CENTRE,
      });

      const customer = await loginAs(app, '+919876760003');
      await app.inject({
        method: 'PATCH',
        url: '/api/v1/users/me/profile',
        headers: customer.authHeader,
        payload: { firstName: 'Cat', lastName: 'Customer' },
      });
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/rides/requests',
        headers: customer.authHeader,
        payload: {
          vehicleTypeId,
          pickupLat: CENTRE.latitude,
          pickupLng: CENTRE.longitude,
          dropLat: 12.9352,
          dropLng: 77.6245,
        },
      });
      assert.equal(created.statusCode, 200, created.payload);
      const requestId = created.json().data.id as string;

      // Nothing has been dispatched yet: the event is committed but undelivered.
      assert.equal(await db().client.rideDispatch.count({ where: { requestId } }), 0);

      await drainOutbox();

      // RideRequestedConsumer ran, for real, against the real DispatchService.
      assert.equal(await db().client.rideDispatch.count({ where: { requestId } }), 1);
    });

    it('delivers a hand-published event to a live subscriber', async () => {
      const seen: string[] = [];
      const off = bus().on('ride.requested', (envelope) => {
        seen.push(envelope.eventId);
      });
      try {
        await container.resolve<EventPublisher>('eventPublisher').publish({
          producer: 'tests',
          type: 'ride.requested',
          classification: 'domain',
          aggregateType: 'ride',
          aggregateId: randomUUID(),
          data: { requestId: randomUUID() },
        });
        assert.equal(seen.length, 0, 'a durable event waits on the outbox, it does not fan out');

        await drainOutbox();
        assert.equal(seen.length, 1, 'and reaches the subscriber once the relay runs');
      } finally {
        off();
      }
    });
  });
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { EventBus } from '../../../src/core/events/EventBus.js';
import { RideRealtimeConsumer } from '../../../src/modules/rides/consumers/ride-realtime.consumer.js';
import type { SocketEnvelope } from '../../../src/modules/realtime/events.js';

const RIDE = {
  id: 'ride_1',
  customerId: 'user_cust',
  driverId: 'drv_1',
  status: 'ACCEPTED',
};

interface Emission {
  rooms: string[];
  envelope: SocketEnvelope;
}

function makeWorld(ride: Record<string, unknown> | null = RIDE) {
  const emissions: Emission[] = [];
  const closedRooms: string[] = [];
  const bus = new EventBus();

  const consumer = new RideRealtimeConsumer(
    bus,
    {
      async findById(id: string) {
        return ride && ride.id === id ? ride : null;
      },
    } as never,
    {
      emitToRoom(rooms: string | string[], envelope: SocketEnvelope) {
        emissions.push({ rooms: Array.isArray(rooms) ? rooms : [rooms], envelope });
      },
      async closeRideRoom(rideId: string) {
        closedRooms.push(rideId);
      },
    } as never,
  );

  const unsubscribe = consumer.register();

  async function publish(type: string, data: Record<string, unknown>, eventId = randomUUID()) {
    await bus.emit({
      eventId,
      type,
      version: 1,
      envelopeVersion: 1,
      occurredAt: new Date().toISOString(),
      producer: 'rides',
      subject: { userId: null },
      correlation: { requestId: null, sessionId: null },
      data,
    });
  }

  return { bus, emissions, closedRooms, publish, unsubscribe };
}

describe('Outbox to socket bridge', () => {
  describe('offer events reach only the offered driver', () => {
    const cases: [string, string][] = [
      ['ride.dispatch.offered', 'ride.offer.received'],
      ['ride.dispatch.rejected', 'ride.offer.rejected'],
      ['ride.dispatch.expired', 'ride.offer.expired'],
    ];

    for (const [domainEvent, socketEvent] of cases) {
      it(`maps ${domainEvent} to ${socketEvent} in the driver room`, async () => {
        const world = makeWorld();
        await world.publish(domainEvent, {
          dispatchId: 'dsp_1',
          requestId: 'req_1',
          driverId: 'drv_1',
        });

        assert.equal(world.emissions.length, 1);
        assert.deepEqual(world.emissions[0]!.rooms, ['driver:drv_1']);
        assert.equal(world.emissions[0]!.envelope.type, socketEvent);
        assert.equal(world.emissions[0]!.envelope.data.dispatchId, 'dsp_1');
        world.unsubscribe();
      });
    }

    it('never puts an offer in the customer’s reach', async () => {
      const world = makeWorld();
      await world.publish('ride.dispatch.offered', { dispatchId: 'd', driverId: 'drv_1' });
      const rooms = world.emissions.flatMap((emission) => emission.rooms);
      assert.ok(!rooms.some((name) => name.startsWith('user:')));
      world.unsubscribe();
    });

    it('ignores an offer event with no driver', async () => {
      const world = makeWorld();
      await world.publish('ride.dispatch.offered', { dispatchId: 'd' });
      assert.deepEqual(world.emissions, []);
      world.unsubscribe();
    });
  });

  describe('ride lifecycle events reach both participants', () => {
    const cases: [string, string][] = [
      ['ride.accepted', 'ride.driver.assigned'],
      ['ride.driver_arriving', 'ride.driver.arriving'],
      ['ride.driver_arrived', 'ride.driver.arrived'],
      ['ride.started', 'ride.started'],
      ['ride.completed', 'ride.completed'],
      ['ride.cancelled', 'ride.cancelled'],
    ];

    for (const [domainEvent, socketEvent] of cases) {
      it(`maps ${domainEvent} to ${socketEvent}`, async () => {
        const world = makeWorld();
        await world.publish(domainEvent, { rideId: 'ride_1', driverId: 'drv_1' });

        assert.equal(world.emissions.length, 1);
        const emission = world.emissions[0]!;
        assert.equal(emission.envelope.type, socketEvent);
        // Ride room plus both identity rooms: socket.io unions them, so a client
        // in two of the three still receives one message — and a customer who
        // has not joined the ride room yet is still reached.
        assert.deepEqual(emission.rooms, ['ride:ride_1', 'user:user_cust', 'driver:drv_1']);
        assert.equal(emission.envelope.data.rideId, 'ride_1');
        world.unsubscribe();
      });
    }

    it('closes the ride room after a terminal event', async () => {
      const world = makeWorld();
      await world.publish('ride.completed', { rideId: 'ride_1', totalFare: 250 });
      assert.deepEqual(world.closedRooms, ['ride_1'], 'nobody may keep streaming into a done ride');
      assert.equal(world.emissions[0]!.envelope.data.totalFare, 250);
      world.unsubscribe();
    });

    it('closes the ride room after a cancellation and carries who cancelled', async () => {
      const world = makeWorld();
      await world.publish('ride.cancelled', { rideId: 'ride_1', cancelledBy: 'CUSTOMER' });
      assert.deepEqual(world.closedRooms, ['ride_1']);
      assert.equal(world.emissions[0]!.envelope.data.cancelledBy, 'CUSTOMER');
      world.unsubscribe();
    });

    it('leaves the room open for a non-terminal event', async () => {
      const world = makeWorld();
      await world.publish('ride.driver_arriving', { rideId: 'ride_1' });
      assert.deepEqual(world.closedRooms, []);
      world.unsubscribe();
    });

    it('emits nothing for a ride that no longer exists', async () => {
      const world = makeWorld(null);
      await world.publish('ride.accepted', { rideId: 'ride_gone' });
      assert.deepEqual(world.emissions, []);
      world.unsubscribe();
    });
  });

  describe('ride.requested', () => {
    it('goes to the customer’s own room', async () => {
      const world = makeWorld();
      await world.publish('ride.requested', {
        requestId: 'req_1',
        customerId: 'user_cust',
        vehicleTypeId: 'vt_1',
        quotedFare: 199,
      });

      assert.deepEqual(world.emissions[0]!.rooms, ['user:user_cust']);
      assert.equal(world.emissions[0]!.envelope.type, 'ride.requested');
      assert.equal(world.emissions[0]!.envelope.data.quotedFare, 199);
      world.unsubscribe();
    });
  });

  describe('de-duplication', () => {
    it('carries the outbox event id straight through as the socket event id', async () => {
      const world = makeWorld();
      const eventId = randomUUID();
      await world.publish('ride.accepted', { rideId: 'ride_1' }, eventId);

      // The same domain fact can also arrive as a push notification; this is
      // what lets a client recognise the two as one event.
      assert.equal(world.emissions[0]!.envelope.eventId, eventId);
      world.unsubscribe();
    });

    it('unsubscribes every listener it added', async () => {
      const world = makeWorld();
      world.unsubscribe();
      await world.publish('ride.accepted', { rideId: 'ride_1' });
      assert.deepEqual(world.emissions, []);
    });
  });
});

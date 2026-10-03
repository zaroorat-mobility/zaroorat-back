import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { EventBus } from '../../../src/core/events/EventBus.js';
import { DashboardRealtimeConsumer } from '../../../src/modules/admin/dashboard/dashboard-realtime.consumer.js';
import type { SocketEnvelope } from '../../../src/modules/realtime/events.js';

interface Emission {
  room: string;
  envelope: SocketEnvelope;
}

function makeWorld() {
  const emissions: Emission[] = [];
  const bus = new EventBus();
  const consumer = new DashboardRealtimeConsumer(bus, {
    emitToRoom(room: string | string[], envelope: SocketEnvelope) {
      for (const name of Array.isArray(room) ? room : [room])
        emissions.push({ room: name, envelope });
    },
  } as never);
  const unsubscribe = consumer.register();

  async function publish(type: string, data: Record<string, unknown>, eventId = randomUUID()) {
    await bus.emit({
      eventId,
      type,
      version: 1,
      envelopeVersion: 1,
      occurredAt: '2026-09-30T06:00:00.000Z',
      producer: 'test',
      subject: { userId: null },
      correlation: { requestId: null, sessionId: null },
      data,
    });
  }
  return { emissions, publish, unsubscribe };
}

/// Everything a hint must never carry, whatever the domain payload held.
const SENSITIVE_KEYS = [
  'totalFare',
  'customerId',
  'userId',
  'reason',
  'cancelledBy',
  'approvedBy',
  'amount',
  'latitude',
  'longitude',
  'quotedFare',
  'shiftId',
];

const SENSITIVE_DATA = {
  totalFare: 450,
  customerId: 'user_cust',
  userId: 'user_x',
  reason: 'ADMIN_SUSPENSION',
  cancelledBy: 'CUSTOMER',
  approvedBy: 'admin_1',
  amount: 999,
  latitude: 1,
  longitude: 2,
  quotedFare: 300,
  shiftId: 'shift_1',
};

describe('Dashboard realtime bridge', () => {
  const opsCases: Array<[string, Record<string, unknown>, string, Record<string, unknown>]> = [
    [
      'ride.accepted',
      { rideId: 'r1' },
      'dashboard.ride.changed',
      { rideId: 'r1', status: 'ACCEPTED' },
    ],
    [
      'ride.completed',
      { rideId: 'r1' },
      'dashboard.ride.changed',
      { rideId: 'r1', status: 'COMPLETED' },
    ],
    [
      'ride.cancelled',
      { rideId: 'r1' },
      'dashboard.ride.changed',
      { rideId: 'r1', status: 'CANCELLED' },
    ],
    [
      'ride.requested',
      { requestId: 'q1' },
      'dashboard.ride_request.changed',
      { requestId: 'q1', status: 'SEARCHING' },
    ],
    [
      'ride.request.expired',
      { requestId: 'q1' },
      'dashboard.ride_request.changed',
      { requestId: 'q1', status: 'EXPIRED' },
    ],
    [
      'ride.request.abandoned',
      { requestId: 'q1' },
      'dashboard.ride_request.changed',
      { requestId: 'q1', status: 'ABANDONED' },
    ],
    [
      'driver.status_changed',
      { driverId: 'd1', status: 'ONLINE' },
      'dashboard.driver.status_changed',
      { driverId: 'd1', status: 'ONLINE' },
    ],
    [
      'driver.status_changed',
      { driverId: 'd1', status: 'OFFLINE' },
      'dashboard.driver.status_changed',
      { driverId: 'd1', status: 'OFFLINE' },
    ],
    [
      'driver.onboarded',
      { driverId: 'd1' },
      'dashboard.driver.registration_changed',
      { driverId: 'd1', change: 'ONBOARDED' },
    ],
    [
      'driver.verified',
      { driverId: 'd1' },
      'dashboard.driver.registration_changed',
      { driverId: 'd1', change: 'VERIFIED' },
    ],
  ];

  for (const [domainEvent, data, socketEvent, expected] of opsCases) {
    it(`bridges ${domainEvent} ${JSON.stringify(data)} to ${socketEvent} in the ops room, minimally`, async () => {
      const world = makeWorld();
      const eventId = randomUUID();
      await world.publish(domainEvent, { ...SENSITIVE_DATA, ...data }, eventId);

      const ops = world.emissions.filter((e) => e.room === 'dashboard:ops');
      assert.equal(ops.length, 1);
      assert.equal(ops[0]!.envelope.type, socketEvent);
      assert.equal(
        ops[0]!.envelope.eventId,
        eventId,
        'outbox eventId is carried through for de-duplication',
      );
      assert.deepEqual(ops[0]!.envelope.data, expected);
      for (const key of SENSITIVE_KEYS)
        assert.ok(!(key in ops[0]!.envelope.data), `ops hint leaked ${key}`);
      world.unsubscribe();
    });
  }

  const financeEvents = [
    'ride.completed',
    'payment.ride.collected',
    'driver.subscription.payment.completed',
    'payment.refund.processed',
  ];
  for (const domainEvent of financeEvents) {
    it(`tells only the finance room that ${domainEvent} moved the ledger, with no data`, async () => {
      const world = makeWorld();
      await world.publish(domainEvent, { rideId: 'r1', ...SENSITIVE_DATA });
      const finance = world.emissions.filter((e) => e.room === 'dashboard:finance');
      assert.equal(finance.length, 1);
      assert.equal(finance[0]!.envelope.type, 'dashboard.financials.changed');
      assert.deepEqual(finance[0]!.envelope.data, {});
      world.unsubscribe();
    });
  }

  it('never sends a financial hint to the ops room or an ops hint to the finance room', async () => {
    const world = makeWorld();
    for (const [domainEvent, data] of opsCases) await world.publish(domainEvent, data);
    for (const domainEvent of financeEvents) await world.publish(domainEvent, { rideId: 'r1' });
    for (const e of world.emissions) {
      if (e.room === 'dashboard:ops')
        assert.notEqual(e.envelope.type, 'dashboard.financials.changed');
      else assert.equal(e.envelope.type, 'dashboard.financials.changed');
    }
    world.unsubscribe();
  });

  it('bridges nothing for events that change no dashboard number', async () => {
    const world = makeWorld();
    for (const type of [
      'ride.driver_arriving',
      'ride.driver_arrived',
      'ride.started',
      'ride.dispatch.offered',
      'driver.location_updated',
      'payment.ride.collection_failed',
      'chat.message.new',
    ]) {
      await world.publish(type, { rideId: 'r1', driverId: 'd1', requestId: 'q1' });
    }
    assert.deepEqual(world.emissions, []);
    world.unsubscribe();
  });

  it('ignores malformed payloads instead of emitting a partial hint', async () => {
    const world = makeWorld();
    await world.publish('ride.completed', { rideId: 42 });
    await world.publish('ride.requested', {});
    await world.publish('driver.status_changed', { driverId: 'd1', status: 'ON_TRIP' });
    await world.publish('driver.status_changed', { status: 'ONLINE' });
    // ride.completed still moves the ledger, so only the data-free finance hint remains
    assert.deepEqual(
      world.emissions.map((e) => e.room),
      ['dashboard:finance'],
    );
    world.unsubscribe();
  });

  it('stops emitting after unsubscribe', async () => {
    const world = makeWorld();
    world.unsubscribe();
    await world.publish('ride.completed', { rideId: 'r1' });
    assert.deepEqual(world.emissions, []);
  });
});

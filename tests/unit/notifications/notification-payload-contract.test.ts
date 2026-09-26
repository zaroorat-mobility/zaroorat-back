import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { RideNotificationConsumer } from '../../../src/modules/rides/consumers/ride-notification.consumer.js';
import {
  resolveCollapseKey,
  resolveDeliveryPresentation,
  resolveNotificationPriority,
  type NotificationDeliveryClass,
} from '../../../src/modules/notifications/policies/notification-priority.policy.js';
import type { EventBus, EventEnvelope } from '../../../src/core/events';
import type { RideRepository } from '../../../src/modules/rides/repositories/ride.repository.js';
import type { DriverRepository } from '../../../src/modules/drivers/repositories/driver.repository.js';
import type { DeviceRepository } from '../../../src/modules/auth/repositories/device.repository.js';
import type { NotificationRepository } from '../../../src/modules/notifications/repositories/notification.repository.js';

// ---------------------------------------------------------------------------
// The golden contract. Both mobile apps are intended to assert against this same
// file (Phases 2 and 3), which is the mechanism that stops the backend and a
// client drifting apart the way they did over `type` vs `eventType`.
// ---------------------------------------------------------------------------

interface ContractEvent {
  type: string;
  recipient: string;
  category: NotificationDeliveryClass;
  conditionalIds: string[];
  channelId: string;
  ttlMs: number;
  collapseKey: string | null;
}
interface Contract {
  contractVersion: string;
  alwaysPresent: string[];
  forbidden: string[];
  maxDataBytes: number;
  events: ContractEvent[];
}

const contract: Contract = JSON.parse(
  // Resolved from the repo root: the test scripts run from there, and this file
  // compiles to CommonJS so import.meta is unavailable.
  readFileSync(
    path.join(process.cwd(), 'tests/fixtures/notification-payloads/contract-v1.json'),
    'utf8',
  ),
) as Contract;

const RIDE_ID = '11111111-1111-4111-8111-111111111111';
const DISPATCH_ID = '22222222-2222-4222-8222-222222222222';
const REQUEST_ID = '33333333-3333-4333-8333-333333333333';
const OCCURRED_AT = '2026-09-23T10:00:00.000Z';

/// Event data as the real producers publish it, verified against
/// dispatch.service.ts, lifecycle.service.ts and collection.service.ts.
function envelopeFor(type: string): EventEnvelope {
  const base = { eventId: `evt-${type}`, type, producer: 'rides', occurredAt: OCCURRED_AT };
  if (type === 'ride.dispatch.offered') {
    return {
      ...base,
      data: {
        driverId: 'drv-100',
        dispatchId: DISPATCH_ID,
        requestId: REQUEST_ID,
        expiresAt: '2026-09-23T10:00:30.000Z',
      },
    } as unknown as EventEnvelope;
  }
  if (type === 'ride.request.expired') {
    return {
      ...base,
      data: { customerId: 'cust-100', requestId: REQUEST_ID },
    } as unknown as EventEnvelope;
  }
  if (type === 'ride.cancelled') {
    return {
      ...base,
      data: { rideId: RIDE_ID, cancelledBy: 'driver', toStatus: 'CANCELLED' },
    } as unknown as EventEnvelope;
  }
  if (type.startsWith('payment.')) {
    return {
      ...base,
      producer: 'payments',
      data: { rideId: RIDE_ID, amount: 150, willRetry: false },
    } as unknown as EventEnvelope;
  }
  return { ...base, data: { rideId: RIDE_ID, totalFare: 150 } } as unknown as EventEnvelope;
}

function makeHarness() {
  const created: Array<Record<string, unknown>> = [];
  const handlers = new Map<string, (e: EventEnvelope) => Promise<void>>();

  const eventBusStub = {
    on(type: string, handler: (e: EventEnvelope) => Promise<void>) {
      handlers.set(type, handler);
      return () => handlers.delete(type);
    },
  } as unknown as EventBus;

  const rideRepoStub = {
    async findById(id: string) {
      return id === RIDE_ID
        ? { id: RIDE_ID, customerId: 'cust-100', driverId: 'drv-100', status: 'ACCEPTED' }
        : null;
    },
  } as unknown as RideRepository;

  const driverRepoStub = {
    async findById(id: string) {
      return id === 'drv-100' ? { id: 'drv-100', userId: 'user-drv-100' } : null;
    },
  } as unknown as DriverRepository;

  const notificationRepoStub = {
    async createNotificationWithDelivery(input: Record<string, unknown>) {
      const record = { id: `notif-${created.length + 1}`, ...input };
      created.push(record);
      return {
        notification: record,
        delivery: { id: `del-${record.id}`, channel: 'PUSH' },
        isDuplicate: false,
      };
    },
  } as unknown as NotificationRepository;

  const consumer = new RideNotificationConsumer(
    eventBusStub,
    rideRepoStub,
    driverRepoStub,
    {} as unknown as DeviceRepository,
    notificationRepoStub,
  );
  consumer.register();
  return { handlers, created };
}

/// Drives the real consumer for one event and returns the `data` payloads it
/// produced.
///
/// Memoised deliberately. With no Redis the enqueue burns the full 2s
/// `ENQUEUE_TIMEOUT_MS` before the consumer's catch swallows it, so driving the
/// consumer once per assertion would cost minutes. Once per event is ~20s for the
/// whole suite, and it still exercises the real path — including the bounded
/// enqueue and the failure counter.
const payloadCache = new Map<string, Array<Record<string, string>>>();

async function payloadsFor(type: string): Promise<Array<Record<string, string>>> {
  const cached = payloadCache.get(type);
  if (cached) return cached;

  const { handlers, created } = makeHarness();
  const handler = handlers.get(type);
  assert.ok(handler, `consumer must subscribe to ${type}`);
  await handler(envelopeFor(type));
  assert.ok(created.length > 0, `${type} must create at least one notification`);

  const payloads = created.map((c) => c.data as Record<string, string>);
  payloadCache.set(type, payloads);
  return payloads;
}

// ---------------------------------------------------------------------------

describe('Notification payload contract v1', () => {
  it('subscribes to every event named in the contract', () => {
    const { handlers } = makeHarness();
    for (const event of contract.events) {
      assert.ok(handlers.has(event.type), `no subscription for ${event.type}`);
    }
  });

  for (const event of contract.events) {
    describe(event.type, () => {
      it('emits exactly the contracted key set', async () => {
        for (const payload of await payloadsFor(event.type)) {
          const keys = Object.keys(payload).sort();
          const expected = [...contract.alwaysPresent, ...event.conditionalIds].sort();
          assert.deepEqual(
            keys,
            expected,
            `key set drift for ${event.type}: got ${keys.join(',')} want ${expected.join(',')}`,
          );
        }
      });

      it('carries only string values', async () => {
        for (const payload of await payloadsFor(event.type)) {
          for (const [key, value] of Object.entries(payload)) {
            assert.equal(
              typeof value,
              'string',
              `${event.type}.${key} is ${typeof value}; FCM accepts strings only`,
            );
          }
        }
      });

      it('omits inapplicable ids rather than emitting empty strings', async () => {
        for (const payload of await payloadsFor(event.type)) {
          for (const key of ['rideId', 'dispatchId', 'requestId', 'expiresAt']) {
            if (event.conditionalIds.includes(key)) continue;
            assert.ok(
              !(key in payload),
              `${event.type} must omit ${key} entirely, not emit it empty`,
            );
          }
          for (const value of Object.values(payload)) {
            assert.notEqual(value, '', `${event.type} must not emit an empty-string value`);
          }
        }
      });

      it('never carries a forbidden field', async () => {
        for (const payload of await payloadsFor(event.type)) {
          for (const forbidden of contract.forbidden) {
            assert.ok(!(forbidden in payload), `${event.type} must not carry ${forbidden}`);
          }
        }
      });

      it('sets v, type and eventType consistently', async () => {
        for (const payload of await payloadsFor(event.type)) {
          assert.equal(payload.v, contract.contractVersion);
          assert.equal(payload.type, event.type);
          assert.equal(payload.eventType, event.type, 'eventType must remain a synonym of type');
          assert.equal(payload.timestamp, OCCURRED_AT, 'timestamp must be the envelope instant');
        }
      });

      it('declares the contracted delivery class', async () => {
        for (const payload of await payloadsFor(event.type)) {
          assert.equal(payload.category, event.category);
        }
        assert.equal(resolveNotificationPriority(event.type).deliveryClass, event.category);
      });

      it('stays inside the FCM data budget', async () => {
        for (const payload of await payloadsFor(event.type)) {
          const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
          assert.ok(
            bytes < contract.maxDataBytes,
            `${event.type} payload is ${bytes}B, over the ${contract.maxDataBytes}B budget`,
          );
        }
      });

      it('resolves the contracted channel and TTL', () => {
        const presentation = resolveDeliveryPresentation(event.category);
        assert.equal(presentation.channelId, event.channelId);
        assert.equal(presentation.ttlMs, event.ttlMs);
      });

      it('resolves the contracted collapse key', () => {
        const actual = resolveCollapseKey(event.category, event.type, {
          rideId: event.conditionalIds.includes('rideId') ? RIDE_ID : undefined,
          dispatchId: event.conditionalIds.includes('dispatchId') ? DISPATCH_ID : undefined,
        });
        const expected = event.collapseKey
          ?.replace('<rideId>', RIDE_ID)
          .replace('<dispatchId>', DISPATCH_ID);
        assert.equal(actual, expected ?? null);
      });
    });
  }

  // ── ride.cancelled is the one event with two recipients ──────────────────

  it('ride.cancelled notifies the customer and the assigned driver, once each', async () => {
    const { handlers, created } = makeHarness();
    const handler = handlers.get('ride.cancelled');
    assert.ok(handler);
    await handler(envelopeFor('ride.cancelled'));

    assert.equal(created.length, 2, 'exactly one notification per participant');
    const recipients = created.map((c) => c.userId).sort();
    assert.deepEqual(recipients, ['cust-100', 'user-drv-100']);

    // Distinct idempotency keys, so a redelivered event still yields one each.
    const keys = new Set(created.map((c) => c.idempotencyKey));
    assert.equal(keys.size, 2);
  });

  it('ride.cancelled copy differs by initiator and leaks nothing', async () => {
    const { handlers, created } = makeHarness();
    const handler = handlers.get('ride.cancelled');
    assert.ok(handler);
    await handler(envelopeFor('ride.cancelled')); // cancelledBy: 'driver'

    const customer = created.find((c) => c.userId === 'cust-100');
    const driver = created.find((c) => c.userId === 'user-drv-100');
    assert.match(String(customer?.body), /driver cancelled/i);
    assert.match(String(driver?.body), /has been cancelled/i);

    for (const row of created) {
      const text = `${String(row.title)} ${String(row.body)}`;
      assert.ok(!/\d{10}/.test(text), 'no phone-like digit run in notification copy');
      assert.ok(!/₹/.test(text), 'no fare figure in cancellation copy');
    }
  });

  // ── The offer payload is what makes stale-offer protection possible ──────

  it('ride.dispatch.offered carries dispatchId and expiresAt for stale-offer protection', async () => {
    const [payload] = await payloadsFor('ride.dispatch.offered');
    assert.equal(payload?.dispatchId, DISPATCH_ID);
    assert.equal(payload?.expiresAt, '2026-09-23T10:00:30.000Z');
    assert.equal(payload?.category, 'RIDE_OFFER');
  });

  it('only offer events carry expiresAt', async () => {
    for (const event of contract.events) {
      if (event.type === 'ride.dispatch.offered') continue;
      for (const payload of await payloadsFor(event.type)) {
        assert.ok(!('expiresAt' in payload), `${event.type} must not carry expiresAt`);
      }
    }
  });
});

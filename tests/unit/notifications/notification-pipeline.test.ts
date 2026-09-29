import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RideNotificationConsumer } from '../../../src/modules/rides/consumers/ride-notification.consumer.js';
import type { EventBus, EventEnvelope } from '../../../src/core/events';
import type { RideRepository } from '../../../src/modules/rides/repositories/ride.repository.js';
import type { DriverRepository } from '../../../src/modules/drivers/repositories/driver.repository.js';
import type { DeviceRepository } from '../../../src/modules/auth/repositories/device.repository.js';
import type { NotificationRepository } from '../../../src/modules/notifications/repositories/notification.repository.js';

describe('Notification Pipeline & Failure Isolation', () => {
  function makeConsumerHarness() {
    const createdNotifications: Array<Record<string, unknown>> = [];
    const eventHandlers: Map<string, (e: EventEnvelope) => Promise<void>> = new Map();

    const eventBusStub = {
      on(type: string, handler: (e: EventEnvelope) => Promise<void>) {
        eventHandlers.set(type, handler);
        return () => eventHandlers.delete(type);
      },
    } as unknown as EventBus;

    const rideRepoStub = {
      async findById(id: string) {
        if (id === 'ride-100') {
          return {
            id: 'ride-100',
            customerId: 'cust-100',
            driverId: 'drv-100',
            status: 'ACCEPTED',
          };
        }
        return null;
      },
    } as unknown as RideRepository;

    const driverRepoStub = {
      async findById(id: string) {
        if (id === 'drv-100') return { id: 'drv-100', userId: 'user-drv-100' };
        return null;
      },
    } as unknown as DriverRepository;

    const deviceRepoStub = {} as unknown as DeviceRepository;

    const notificationRepoStub = {
      async createNotificationWithDelivery(input: Record<string, unknown>) {
        const isDuplicate = createdNotifications.some(
          (n) => n.idempotencyKey === input.idempotencyKey,
        );
        const record = {
          id: `notif-${createdNotifications.length + 1}`,
          ...input,
        };
        if (!isDuplicate) {
          createdNotifications.push(record);
        }
        return {
          notification: record,
          delivery: { id: `del-${record.id}`, channel: 'PUSH' },
          isDuplicate,
        };
      },
    } as unknown as NotificationRepository;

    const consumer = new RideNotificationConsumer(
      eventBusStub,
      rideRepoStub,
      driverRepoStub,
      deviceRepoStub,
      notificationRepoStub,
    );

    consumer.register();

    return { consumer, eventHandlers, createdNotifications };
  }

  it('subscribes to domain events and creates idempotent notification records', async () => {
    const { eventHandlers, createdNotifications } = makeConsumerHarness();

    const handler = eventHandlers.get('ride.accepted');
    assert.ok(handler, 'Handler for ride.accepted should be registered');

    const envelope: EventEnvelope = {
      eventId: 'evt-unique-1',
      type: 'ride.accepted',
      producer: 'rides',
      occurredAt: new Date().toISOString(),
      data: { rideId: 'ride-100' },
    } as unknown as EventEnvelope;

    // First event processing
    if (handler) await handler(envelope);
    assert.equal(createdNotifications.length, 1);
    assert.equal(
      createdNotifications[0]!.idempotencyKey,
      'evt-unique-1:ride.accepted:cust-100:PUSH',
    );

    // Duplicate event re-delivery (same outbox eventId)
    if (handler) await handler(envelope);
    assert.equal(
      createdNotifications.length,
      1,
      'Duplicate event must NOT create a second notification record',
    );
  });

  it('isolates notification processing failures without throwing exceptions', async () => {
    const { eventHandlers } = makeConsumerHarness();

    // Trigger ride.accepted with non-existent rideId. Driven through the
    // registered handler — the consumer's only entry point — rather than a
    // private method (F3 S5 moved per-event handling into the planner).
    const envelope: EventEnvelope = {
      eventId: 'evt-missing-ride',
      type: 'ride.accepted',
      producer: 'rides',
      occurredAt: new Date().toISOString(),
      data: { rideId: 'ride-missing' },
    } as unknown as EventEnvelope;

    const handler = eventHandlers.get('ride.accepted');
    assert.ok(handler, 'Handler for ride.accepted should be registered');

    // Should complete cleanly without throwing error (failure isolation)
    await assert.doesNotReject(async () => {
      await handler(envelope);
    });
  });
});

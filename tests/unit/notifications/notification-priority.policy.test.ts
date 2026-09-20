import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveNotificationPriority } from '../../../src/modules/notifications/policies/notification-priority.policy.js';

describe('NotificationPriorityPolicy', () => {
  it('assigns HIGH priority (1) to dispatch offers and ride accepted events', () => {
    const offer = resolveNotificationPriority('ride.dispatch.offered');
    assert.equal(offer.bullMqPriority, 1);
    assert.equal(offer.prismaPriority, 'HIGH');

    const accepted = resolveNotificationPriority('ride.accepted');
    assert.equal(accepted.bullMqPriority, 1);
    assert.equal(accepted.prismaPriority, 'HIGH');
  });

  it('assigns NORMAL priority (2) to status updates and receipts', () => {
    const completed = resolveNotificationPriority('ride.completed');
    assert.equal(completed.bullMqPriority, 2);
    assert.equal(completed.prismaPriority, 'NORMAL');

    const collected = resolveNotificationPriority('payment.ride.collected');
    assert.equal(collected.bullMqPriority, 2);
    assert.equal(collected.prismaPriority, 'NORMAL');
  });

  it('assigns LOW priority (3) to promotional broadcasts', () => {
    const promo = resolveNotificationPriority('promotional.broadcast');
    assert.equal(promo.bullMqPriority, 3);
    assert.equal(promo.prismaPriority, 'LOW');
  });

  it('defaults to NORMAL priority (2) for unknown event keys', () => {
    const unknown = resolveNotificationPriority('custom.unknown.event');
    assert.equal(unknown.bullMqPriority, 2);
    assert.equal(unknown.prismaPriority, 'NORMAL');
  });
});

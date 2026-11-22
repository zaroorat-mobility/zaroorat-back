import type { EventEnvelope } from '@core/events';
import type { NotificationRepository } from '@modules/notifications/repositories/notification.repository.js';
import { resolveOfferWindow } from '@modules/notifications/policies/notification-priority.policy.js';
import {
  notificationCreated,
  notificationEnqueueFailed,
} from '@modules/notifications/metrics/notification.metrics.js';
import { logger } from '@shared/logger/index.js';
import {
  ENQUEUE_TIMEOUT_MS,
  JOB_NAMES,
  notificationsQueue,
  raceWithTimeout,
} from '../../../jobs/queues/index.js';
import type { NotificationPlan } from './ride-notification.planner.js';

/// What happened to one planned notification. Only `enqueued` is success.
export type WriteOutcome =
  | { kind: 'enqueued'; notificationId: string; deliveryId: string }
  /// Already written for this event and recipient (the idempotency key). The
  /// first writer owns its enqueue; PA-11 owns it if that enqueue was lost.
  | { kind: 'duplicate'; notificationId: string }
  /// Written, and settled FAILED/OFFER_EXPIRED instead of being enqueued.
  | { kind: 'offer_expired'; notificationId: string; deliveryId: string }
  /// Written and left QUEUED, but the job is not in the queue. Counted and
  /// logged here; the PA-11 reconciliation sweep is what enqueues it.
  | { kind: 'enqueue_failed'; notificationId: string; deliveryId: string; error: unknown };

/// Persists one planned notification and enqueues its delivery: the side effects
/// the consumer has always performed for one recipient, shared so the consumer
/// and the outbox reconciliation perform them identically.
///
/// Errors are not swallowed here. A failure to persist — the insert, or settling
/// an expired offer — propagates unchanged; the caller decides what it means
/// (the consumer isolates it per recipient, reconciliation classifies it). An
/// enqueue failure does not throw, because the row is already durable and
/// recoverable, but it is reported as `enqueue_failed` and never as success.
///
/// One plan per call, with no state shared between calls, so a failure for one
/// recipient cannot reach another.
export async function writeNotificationPlan(
  envelope: EventEnvelope,
  plan: NotificationPlan,
  notificationRepository: NotificationRepository,
): Promise<WriteOutcome> {
  const { input, deliveryClass, bullMqPriority } = plan;
  // One context object, carried on every log line in this path and handed to
  // the worker through the job payload, so a single notification can be
  // followed from here to the FCM call.
  const trace = {
    eventId: envelope.eventId,
    eventType: envelope.type,
    userId: input.userId,
    rideId: input.referenceId ?? null,
    category: deliveryClass,
  };

  const { notification, delivery, isDuplicate } =
    await notificationRepository.createNotificationWithDelivery(input);

  if (isDuplicate || !delivery) {
    logger.info(
      { ...trace, idempotencyKey: input.idempotencyKey, notificationId: notification.id },
      '[rides] duplicate event notification skipped',
    );
    return { kind: 'duplicate', notificationId: notification.id };
  }

  notificationCreated({
    event_type: envelope.type,
    category: deliveryClass,
  });

  // An offer whose window closed before the relay reached it can only ever
  // present something the driver must not act on. Recorded, not enqueued —
  // the row stays as the trace of an offer the driver was never told about.
  if (deliveryClass === 'RIDE_OFFER') {
    const expiresAt = input.data?.expiresAt;
    const window = resolveOfferWindow(expiresAt, Date.now());
    if (window?.expired) {
      logger.info(
        { ...trace, notificationId: notification.id, expiresAt },
        '[rides] ride offer expired before its notification could be enqueued; not sent',
      );
      await notificationRepository.updateDeliveryStatus(delivery.id, {
        status: 'FAILED',
        errorCode: 'OFFER_EXPIRED',
        failureReason: 'Ride offer expired before its notification was enqueued',
      });
      await notificationRepository.updateNotificationStatus(notification.id, 'FAILED');
      return { kind: 'offer_expired', notificationId: notification.id, deliveryId: delivery.id };
    }
  }

  try {
    // Bounded. An unbounded await here stalls the outbox relay — see
    // ENQUEUE_TIMEOUT_MS. Both outcomes land in the same catch, and both
    // leave the row QUEUED for the reconciliation sweep: a timeout is a
    // transient Redis condition, not a reason to mark a notification dead.
    await raceWithTimeout(
      notificationsQueue().add(
        JOB_NAMES.NOTIFICATION_DELIVERY,
        {
          notificationId: notification.id,
          deliveryId: delivery.id,
          ...trace,
        },
        {
          jobId: notification.id,
          priority: bullMqPriority,
        },
      ),
      ENQUEUE_TIMEOUT_MS,
    );
  } catch (enqueueErr) {
    // The row is committed and the job is not. Counted and logged distinctly
    // from any other failure because this is the one case the reconciliation
    // sweep exists to recover, and because a silent version of this is how a
    // notification used to be lost forever on a Redis blip.
    notificationEnqueueFailed({
      event_type: envelope.type,
      category: deliveryClass,
    });
    logger.error(
      { ...trace, err: enqueueErr, notificationId: notification.id, deliveryId: delivery.id },
      '[rides] notification persisted but enqueue failed; left QUEUED for the reconciliation sweep',
    );
    return {
      kind: 'enqueue_failed',
      notificationId: notification.id,
      deliveryId: delivery.id,
      error: enqueueErr,
    };
  }

  return { kind: 'enqueued', notificationId: notification.id, deliveryId: delivery.id };
}

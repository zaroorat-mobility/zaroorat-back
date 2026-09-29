import { EventBus, type EventEnvelope, type Unsubscribe } from '@core/events';
import { DeviceRepository } from '@modules/auth/repositories/device.repository.js';
import { DriverRepository } from '@modules/drivers/repositories/driver.repository.js';
import { NotificationRepository } from '@modules/notifications';
import { notificationLiveFailure } from '@modules/notifications/metrics/notification.metrics.js';
import { logger } from '@shared/logger/index.js';
import { RideRepository } from '../repositories/ride.repository.js';
import {
  NOTIFICATION_EVENT_TYPES,
  planNotifications,
  type NotificationLookups,
  type NotificationPlan,
} from './ride-notification.planner.js';
import { writeNotificationPlan } from './ride-notification.writer.js';

// The payload contract version lives with the payload, in the planner.
export { NOTIFICATION_CONTRACT_VERSION } from './ride-notification.planner.js';

// The enqueue bound and its helper live with the queues, so the reconciliation
// sweep can share them; re-exported here for existing importers.
export { EnqueueTimeoutError, raceWithTimeout } from '../../../jobs/queues/index.js';

/// Push notifications for ride and payment events, off the outbox relay.
///
/// Who is told what is decided by the planner and written by the writer — the
/// same two functions the outbox reconciliation uses, so the live path and the
/// recovery path cannot disagree. This class only wires them to the bus and
/// keeps each recipient's failure to that recipient.
export class RideNotificationConsumer {
  /// The ride is read for its participants rather than trusting the envelope.
  private readonly lookups: NotificationLookups = {
    findRide: (rideId) => this.rideRepo.findById(rideId),
    findDriver: (driverId) => this.driverRepository.findById(driverId),
  };

  constructor(
    private readonly eventBus: EventBus,
    private readonly rideRepo: RideRepository,
    private readonly driverRepository: DriverRepository,
    private readonly deviceRepository: DeviceRepository,
    private readonly notificationRepository: NotificationRepository,
  ) {}

  register(): Unsubscribe {
    const unsubscribes = NOTIFICATION_EVENT_TYPES.map((type) =>
      this.eventBus.on(type, (e) => this.handle(e)),
    );
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
  }

  /// Plans every recipient of the event, then writes each one on its own, in the
  /// planner's order (customer before driver). A failed lookup or write for one
  /// recipient is logged and never costs another theirs.
  ///
  /// Only planning can reject, and only for an envelope with no `data` — which
  /// has always failed the dispatch rather than published it.
  private async handle(envelope: EventEnvelope): Promise<void> {
    for (const outcome of await planNotifications(envelope, this.lookups)) {
      if (outcome.kind === 'lookup_failed') {
        logger.warn(
          { err: outcome.error, eventId: envelope.eventId, eventType: envelope.type },
          `[rides] failed to push-notify ${outcome.audience}`,
        );
        notificationLiveFailure('lookup_failed', { event_type: envelope.type });
      } else if (outcome.kind === 'notify') {
        await this.write(envelope, outcome.plan);
      }
    }
  }

  private async write(envelope: EventEnvelope, plan: NotificationPlan): Promise<void> {
    const labels = { event_type: envelope.type, category: plan.deliveryClass };
    try {
      // An `enqueue_failed` outcome is not an error here: the row is committed
      // QUEUED, the writer has counted and logged it, and PA-11 re-enqueues it.
      // Counted once more as the live path's own, apart from reconciliation's.
      const written = await writeNotificationPlan(envelope, plan, this.notificationRepository);
      if (written.kind === 'enqueue_failed') notificationLiveFailure('enqueue_failed', labels);
    } catch (err) {
      // Lost until the outbox reconciliation recovers it.
      notificationLiveFailure('persist_failed', labels);
      // Deliberately swallowed. This consumer runs post-commit off the outbox
      // relay, and throwing here would mark the outbox row failed and redeliver
      // a domain event whose ride or payment work is already durably committed.
      // Notification failure must stay isolated from ride and payment state.
      logger.warn(
        {
          eventId: envelope.eventId,
          eventType: envelope.type,
          userId: plan.input.userId,
          rideId: plan.input.referenceId ?? null,
          category: plan.deliveryClass,
          err,
        },
        '[rides] failed to process push notification',
      );
    }
  }
}

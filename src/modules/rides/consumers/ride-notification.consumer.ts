import { EventBus, type EventEnvelope, type Unsubscribe } from '@core/events';
import { DeviceRepository } from '@modules/auth/repositories/device.repository.js';
import { DriverRepository } from '@modules/drivers/repositories/driver.repository.js';
import { NotificationRepository } from '@modules/notifications';
import {
  resolveNotificationPriority,
  resolveOfferWindow,
} from '@modules/notifications/policies/notification-priority.policy.js';
import {
  notificationCreated,
  notificationEnqueueFailed,
} from '@modules/notifications/metrics/notification.metrics.js';
import {
  notificationsQueue,
  JOB_NAMES,
  ENQUEUE_TIMEOUT_MS,
  raceWithTimeout,
} from '../../../jobs/queues/index.js';
import { logger } from '@shared/logger/index.js';
import { RideRepository } from '../repositories/ride.repository.js';
import { RIDE_EVENT_CATALOG } from '../events/catalog.js';
import { PAYMENT_EVENT_CATALOG } from '@modules/payments/events/catalog.js';

/// Payload contract version (spec §19.4). Bumped only when a field is removed or
/// re-typed; adding a field is a minor change and clients ignore what they do not
/// recognise. A client seeing an unknown version must fall back to its inbox
/// rather than guess.
export const NOTIFICATION_CONTRACT_VERSION = '1';

// The enqueue bound and its helper live with the queues, so the reconciliation
// sweep can share them; re-exported here for existing importers.
export { EnqueueTimeoutError, raceWithTimeout } from '../../../jobs/queues/index.js';

export class RideNotificationConsumer {
  constructor(
    private readonly eventBus: EventBus,
    private readonly rideRepo: RideRepository,
    private readonly driverRepository: DriverRepository,
    private readonly deviceRepository: DeviceRepository,
    private readonly notificationRepository: NotificationRepository,
  ) {}

  register(): Unsubscribe {
    const unsubscribes = [
      this.eventBus.on(RIDE_EVENT_CATALOG.DISPATCH_OFFERED, (e) => this.onDispatchOffered(e)),
      this.eventBus.on(RIDE_EVENT_CATALOG.ACCEPTED, (e) =>
        this.onRideEvent(
          e,
          'Driver assigned',
          'Your driver is on the way to your pickup location.',
        ),
      ),
      this.eventBus.on(RIDE_EVENT_CATALOG.DRIVER_ARRIVING, (e) =>
        this.onRideEvent(e, 'Your driver is on the way', 'Your driver has started heading to you.'),
      ),
      this.eventBus.on(RIDE_EVENT_CATALOG.DRIVER_ARRIVED, (e) =>
        this.onRideEvent(
          e,
          'Your driver has arrived',
          'Your driver is waiting at the pickup point.',
        ),
      ),
      this.eventBus.on(RIDE_EVENT_CATALOG.STARTED, (e) =>
        this.onRideEvent(e, 'Trip started', 'Your trip is now in progress.'),
      ),
      this.eventBus.on(RIDE_EVENT_CATALOG.COMPLETED, (e) => this.onCompleted(e)),
      this.eventBus.on(RIDE_EVENT_CATALOG.CANCELLED, (e) => this.onCancelled(e)),
      this.eventBus.on(RIDE_EVENT_CATALOG.REQUEST_EXPIRED, (e) => this.onRequestExpired(e)),
      this.eventBus.on(PAYMENT_EVENT_CATALOG.RIDE_COLLECTED, (e) => this.onCollected(e)),
      this.eventBus.on(PAYMENT_EVENT_CATALOG.RIDE_COLLECTION_FAILED, (e) =>
        this.onCollectionFailed(e),
      ),
    ];
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
  }

  private async onDispatchOffered(envelope: EventEnvelope): Promise<void> {
    const data = envelope.data as { driverId?: string };
    if (!data.driverId) return;
    await this.pushToDriver(
      data.driverId,
      'New ride request',
      'A ride is nearby — open the app to accept.',
      envelope,
    );
  }

  private async onRideEvent(envelope: EventEnvelope, title: string, body: string): Promise<void> {
    const data = envelope.data as { rideId?: string };
    if (!data.rideId) return;
    await this.pushToRideCustomer(data.rideId, title, body, envelope);
  }

  private async onCompleted(envelope: EventEnvelope): Promise<void> {
    const data = envelope.data as { rideId?: string; totalFare?: number };
    if (!data.rideId) return;
    const fareText =
      typeof data.totalFare === 'number' ? ` Fare: ₹${data.totalFare.toFixed(2)}.` : '';
    await this.pushToRideCustomer(
      data.rideId,
      'Trip completed',
      `You have arrived at your destination.${fareText}`,
      envelope,
    );
  }

  /// Both participants are told, and the copy differs by who cancelled — the
  /// rider needs to know whether to rebook, and the driver needs to know they
  /// are free again. Neither message carries a name, a vehicle number or a fare:
  /// a notification is readable from a locked screen.
  ///
  /// The ride is read for its participants rather than trusting the envelope,
  /// which is also how `pushToRideCustomer` resolves the customer.
  private async onCancelled(envelope: EventEnvelope): Promise<void> {
    const data = envelope.data as { rideId?: string; cancelledBy?: string };
    if (!data.rideId) return;

    const byDriver = data.cancelledBy === 'driver';
    const byCustomer = data.cancelledBy === 'customer';

    await this.pushToRideCustomer(
      data.rideId,
      'Ride cancelled',
      byDriver
        ? 'Your driver cancelled this trip. Book again and we will find you another driver.'
        : 'Your trip has been cancelled.',
      envelope,
    );

    try {
      const ride = await this.rideRepo.findById(data.rideId);
      if (!ride?.driverId) return;
      await this.pushToDriver(
        ride.driverId,
        'Ride cancelled',
        byCustomer
          ? 'The passenger cancelled this trip. You are back online.'
          : 'This trip has been cancelled.',
        envelope,
      );
    } catch (err) {
      logger.warn({ err, rideId: data.rideId }, '[rides] failed to push-notify driver of cancel');
    }
  }

  private async onRequestExpired(envelope: EventEnvelope): Promise<void> {
    const data = envelope.data as { customerId?: string };
    if (!data.customerId) return;
    try {
      await this.pushToUser(
        data.customerId,
        'No drivers available',
        'We could not find a driver for your trip. Please try booking again.',
        envelope,
      );
    } catch (err) {
      logger.warn({ err, customerId: data.customerId }, '[rides] failed to push-notify customer');
    }
  }

  private async onCollected(envelope: EventEnvelope): Promise<void> {
    const data = envelope.data as { rideId?: string; amount?: number };
    if (!data.rideId) return;
    const amountText = typeof data.amount === 'number' ? ` ₹${data.amount.toFixed(2)}` : '';
    await this.pushToRideCustomer(
      data.rideId,
      'Payment received',
      `Your fare of${amountText} has been paid. Thanks for riding.`,
      envelope,
    );
  }

  private async onCollectionFailed(envelope: EventEnvelope): Promise<void> {
    const data = envelope.data as { rideId?: string; willRetry?: boolean };
    if (!data.rideId || data.willRetry !== false) return;
    await this.pushToRideCustomer(
      data.rideId,
      'Payment unsuccessful',
      'We could not collect the fare for your last trip. Open the app to settle it.',
      envelope,
    );
  }

  /// The canonical FCM `data` payload (spec §19.1, contract v1).
  ///
  /// Every value is a string because FCM rejects anything else. Conditional ids
  /// are *omitted* rather than emitted empty: an empty `dispatchId` is what made
  /// the driver client's identity match fall through to "show whatever offer is
  /// first", which is how a stale push could present a live offer the driver had
  /// never been offered.
  ///
  /// `eventType` is retained verbatim alongside the new `type`. It is the field
  /// the shipped driver build reads, so removing it would break a client that
  /// cannot be updated in this phase. `type` is its synonym and the field the
  /// shipped customer build already reads — which is why adding it fixes
  /// customer deep-linking with no app release.
  ///
  /// No `deepLink`: the field is optional in the contract, both apps already map
  /// `type` to a route locally, and the two apps use different URL schemes and
  /// different screen names. Emitting it here would move every mobile route
  /// table into the backend for no gain in this phase.
  ///
  /// No `userId`: the device is already bound to exactly one authenticated user,
  /// and every screen reached from a notification must re-authorise its subject
  /// against the backend regardless. Including it would invite a client to treat
  /// it as authorisation.
  private buildPayload(envelope: EventEnvelope): Record<string, string> {
    const data = (envelope.data ?? {}) as {
      rideId?: unknown;
      dispatchId?: unknown;
      requestId?: unknown;
      expiresAt?: unknown;
    };
    const { deliveryClass } = resolveNotificationPriority(envelope.type);

    const payload: Record<string, string> = {
      v: NOTIFICATION_CONTRACT_VERSION,
      type: envelope.type,
      eventType: envelope.type,
      eventId: envelope.eventId,
      timestamp: envelope.occurredAt,
      category: deliveryClass,
    };

    if (typeof data.rideId === 'string') payload.rideId = data.rideId;
    if (typeof data.dispatchId === 'string') payload.dispatchId = data.dispatchId;
    if (typeof data.requestId === 'string') payload.requestId = data.requestId;
    // Offer events only. Lets the driver client refuse to present an offer whose
    // window has already closed without a round trip first.
    if (deliveryClass === 'RIDE_OFFER' && typeof data.expiresAt === 'string') {
      payload.expiresAt = data.expiresAt;
    }

    return payload;
  }

  private async pushToDriver(
    driverId: string,
    title: string,
    body: string,
    envelope: EventEnvelope,
  ): Promise<void> {
    try {
      const driver = await this.driverRepository.findById(driverId);
      if (!driver) return;
      await this.pushToUser(driver.userId, title, body, envelope);
    } catch (err) {
      logger.warn({ err, driverId }, '[rides] failed to push-notify driver');
    }
  }

  private async pushToRideCustomer(
    rideId: string,
    title: string,
    body: string,
    envelope: EventEnvelope,
  ): Promise<void> {
    try {
      const ride = await this.rideRepo.findById(rideId);
      if (!ride) return;
      await this.pushToUser(ride.customerId, title, body, envelope);
    } catch (err) {
      logger.warn({ err, rideId }, '[rides] failed to push-notify customer');
    }
  }

  private async pushToUser(
    userId: string,
    title: string,
    body: string,
    envelope: EventEnvelope,
  ): Promise<void> {
    const idempotencyKey = `${envelope.eventId}:${envelope.type}:${userId}:PUSH`;
    const priorityMapping = resolveNotificationPriority(envelope.type);
    const rideId = (envelope.data as { rideId?: string })?.rideId ?? null;
    // One context object, carried on every log line in this path and handed to
    // the worker through the job payload, so a single notification can be
    // followed from here to the FCM call. Before this, the consumer logged
    // eventId+userId and the worker logged notificationId+deliveryId, and no
    // line carried both.
    const trace = {
      eventId: envelope.eventId,
      eventType: envelope.type,
      userId,
      rideId,
      category: priorityMapping.deliveryClass,
    };

    try {
      const payload = this.buildPayload(envelope);
      const { notification, delivery, isDuplicate } =
        await this.notificationRepository.createNotificationWithDelivery({
          userId,
          category: 'TRANSACTIONAL',
          priority: priorityMapping.prismaPriority,
          eventKey: envelope.type,
          idempotencyKey,
          title,
          body,
          data: payload,
          referenceType: rideId ? 'RIDE' : null,
          referenceId: rideId,
          channel: 'PUSH',
        });

      if (isDuplicate || !delivery) {
        logger.info(
          { ...trace, idempotencyKey, notificationId: notification.id },
          '[rides] duplicate event notification skipped',
        );
        return;
      }

      notificationCreated({
        event_type: envelope.type,
        category: priorityMapping.deliveryClass,
      });

      // An offer whose window closed before the relay reached it can only ever
      // present something the driver must not act on. Recorded, not enqueued —
      // the row stays as the trace of an offer the driver was never told about.
      if (priorityMapping.deliveryClass === 'RIDE_OFFER') {
        const window = resolveOfferWindow(payload.expiresAt, Date.now());
        if (window?.expired) {
          logger.info(
            { ...trace, notificationId: notification.id, expiresAt: payload.expiresAt },
            '[rides] ride offer expired before its notification could be enqueued; not sent',
          );
          await this.notificationRepository.updateDeliveryStatus(delivery.id, {
            status: 'FAILED',
            errorCode: 'OFFER_EXPIRED',
            failureReason: 'Ride offer expired before its notification was enqueued',
          });
          await this.notificationRepository.updateNotificationStatus(notification.id, 'FAILED');
          return;
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
              priority: priorityMapping.bullMqPriority,
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
          category: priorityMapping.deliveryClass,
        });
        logger.error(
          { ...trace, err: enqueueErr, notificationId: notification.id, deliveryId: delivery.id },
          '[rides] notification persisted but enqueue failed; left QUEUED for the reconciliation sweep',
        );
      }
    } catch (err) {
      // Deliberately swallowed. This consumer runs post-commit off the outbox
      // relay, and throwing here would mark the outbox row failed and redeliver
      // a domain event whose ride or payment work is already durably committed.
      // Notification failure must stay isolated from ride and payment state.
      logger.warn({ ...trace, err }, '[rides] failed to process push notification');
    }
  }
}

import type { EventEnvelope } from '@core/events';
import type { CreateNotificationInput } from '@modules/notifications/repositories/notification.repository.js';
import {
  resolveNotificationPriority,
  type NotificationDeliveryClass,
} from '@modules/notifications/policies/notification-priority.policy.js';
import { PAYMENT_EVENT_CATALOG } from '@modules/payments/events/catalog.js';
import { RIDE_EVENT_CATALOG } from '../events/catalog.js';

/// Decides who is told what about a ride or payment event — and nothing else.
///
/// Shared by the live consumer and the outbox reconciliation (F3), so the two can
/// never disagree about a notification. It writes nothing, enqueues nothing and
/// reads no clock; the only I/O is the two injected lookups. Persisting a plan,
/// the offer-window check and the enqueue stay with the caller.
///
/// It reproduces the pre-F3 `RideNotificationConsumer` exactly, pinned by the
/// golden table in tests/unit/notifications/ride-notification.golden.ts —
/// including its quirks: "missing" means falsy, `willRetry` must be literally
/// `false`, and user state (erased, blocked) is never consulted.

/// Payload contract version (spec §19.4). Bumped only when a field is removed or
/// re-typed; adding a field is a minor change and clients ignore what they do not
/// recognise. A client seeing an unknown version must fall back to its inbox
/// rather than guess.
export const NOTIFICATION_CONTRACT_VERSION = '1';

/// Every event that produces a push notification.
export const NOTIFICATION_EVENT_TYPES = [
  RIDE_EVENT_CATALOG.DISPATCH_OFFERED,
  RIDE_EVENT_CATALOG.ACCEPTED,
  RIDE_EVENT_CATALOG.DRIVER_ARRIVING,
  RIDE_EVENT_CATALOG.DRIVER_ARRIVED,
  RIDE_EVENT_CATALOG.STARTED,
  RIDE_EVENT_CATALOG.COMPLETED,
  RIDE_EVENT_CATALOG.CANCELLED,
  RIDE_EVENT_CATALOG.REQUEST_EXPIRED,
  PAYMENT_EVENT_CATALOG.RIDE_COLLECTED,
  PAYMENT_EVENT_CATALOG.RIDE_COLLECTION_FAILED,
] as const;

export type NotificationAudience = 'customer' | 'driver';

export type PlanSkipReason =
  | 'missing_ride_id'
  | 'missing_driver_id'
  | 'missing_customer_id'
  | 'will_retry'
  | 'ride_not_found'
  | 'ride_has_no_driver'
  | 'driver_not_found';

/// The only reads a plan needs. The consumer backs these with the repositories;
/// reconciliation with rows it has already batch-loaded.
export interface NotificationLookups {
  findRide(rideId: string): Promise<{ customerId: string; driverId: string | null } | null>;
  findDriver(driverId: string): Promise<{ userId: string } | null>;
}

export interface NotificationPlan {
  audience: NotificationAudience;
  deliveryClass: NotificationDeliveryClass;
  bullMqPriority: number;
  /// Exactly what `createNotificationWithDelivery` receives.
  input: CreateNotificationInput & { idempotencyKey: string };
}

/// One outcome per audience the event concerns, in the order the consumer has
/// always handled them (customer before driver). A failed lookup is an outcome,
/// not an exception, so one participant's failure never costs the other theirs.
export type PlanOutcome =
  | { kind: 'notify'; plan: NotificationPlan }
  | { kind: 'skip'; audience: NotificationAudience; reason: PlanSkipReason }
  | { kind: 'lookup_failed'; audience: NotificationAudience; error: unknown };

/// The event + recipient + channel idempotency rule. The unique index on
/// `notifications.idempotency_key` is what makes a notification exist once.
export function notificationIdempotencyKey(envelope: EventEnvelope, userId: string): string {
  return `${envelope.eventId}:${envelope.type}:${userId}:PUSH`;
}

/// The canonical FCM `data` payload (spec §19.1, contract v1).
///
/// Every value is a string because FCM rejects anything else. Conditional ids
/// are *omitted* rather than emitted empty: an empty `dispatchId` is what made
/// the driver client's identity match fall through to "show whatever offer is
/// first", which is how a stale push could present a live offer the driver had
/// never been offered.
///
/// `eventType` is retained verbatim alongside `type`: the shipped driver build
/// reads `eventType`, the shipped customer build reads `type`.
///
/// No `deepLink` (both apps map `type` to a route locally) and no `userId` (the
/// device is already bound to one user, and a client must never treat it as
/// authorisation).
export function buildNotificationPayload(envelope: EventEnvelope): Record<string, string> {
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

export async function planNotifications(
  envelope: EventEnvelope,
  lookups: NotificationLookups,
): Promise<PlanOutcome[]> {
  switch (envelope.type) {
    case RIDE_EVENT_CATALOG.DISPATCH_OFFERED: {
      const data = envelope.data as { driverId?: string };
      if (!data.driverId) return [skip('driver', 'missing_driver_id')];
      return [
        await toDriver(
          envelope,
          lookups,
          data.driverId,
          'New ride request',
          'A ride is nearby — open the app to accept.',
        ),
      ];
    }
    case RIDE_EVENT_CATALOG.ACCEPTED:
      return toRideCustomerOf(
        envelope,
        lookups,
        'Driver assigned',
        'Your driver is on the way to your pickup location.',
      );
    case RIDE_EVENT_CATALOG.DRIVER_ARRIVING:
      return toRideCustomerOf(
        envelope,
        lookups,
        'Your driver is on the way',
        'Your driver has started heading to you.',
      );
    case RIDE_EVENT_CATALOG.DRIVER_ARRIVED:
      return toRideCustomerOf(
        envelope,
        lookups,
        'Your driver has arrived',
        'Your driver is waiting at the pickup point.',
      );
    case RIDE_EVENT_CATALOG.STARTED:
      return toRideCustomerOf(envelope, lookups, 'Trip started', 'Your trip is now in progress.');
    case RIDE_EVENT_CATALOG.COMPLETED: {
      const data = envelope.data as { rideId?: string; totalFare?: number };
      if (!data.rideId) return [skip('customer', 'missing_ride_id')];
      const fareText =
        typeof data.totalFare === 'number' ? ` Fare: ₹${data.totalFare.toFixed(2)}.` : '';
      return [
        await toRideCustomer(
          envelope,
          lookups,
          data.rideId,
          'Trip completed',
          `You have arrived at your destination.${fareText}`,
        ),
      ];
    }
    case RIDE_EVENT_CATALOG.CANCELLED:
      return planCancelled(envelope, lookups);
    case RIDE_EVENT_CATALOG.REQUEST_EXPIRED: {
      // The recipient comes from the payload: there is no ride yet to read it from.
      const data = envelope.data as { customerId?: string };
      if (!data.customerId) return [skip('customer', 'missing_customer_id')];
      return [
        notify(
          envelope,
          'customer',
          data.customerId,
          'No drivers available',
          'We could not find a driver for your trip. Please try booking again.',
        ),
      ];
    }
    case PAYMENT_EVENT_CATALOG.RIDE_COLLECTED: {
      const data = envelope.data as { rideId?: string; amount?: number };
      if (!data.rideId) return [skip('customer', 'missing_ride_id')];
      const amountText = typeof data.amount === 'number' ? ` ₹${data.amount.toFixed(2)}` : '';
      return [
        await toRideCustomer(
          envelope,
          lookups,
          data.rideId,
          'Payment received',
          `Your fare of${amountText} has been paid. Thanks for riding.`,
        ),
      ];
    }
    case PAYMENT_EVENT_CATALOG.RIDE_COLLECTION_FAILED: {
      // Only the attempt that exhausts the budget (`willRetry: false`, literally)
      // is the rider's problem; every earlier failure is retried silently.
      const data = envelope.data as { rideId?: string; willRetry?: boolean };
      if (!data.rideId) return [skip('customer', 'missing_ride_id')];
      if (data.willRetry !== false) return [skip('customer', 'will_retry')];
      return [
        await toRideCustomer(
          envelope,
          lookups,
          data.rideId,
          'Payment unsuccessful',
          'We could not collect the fare for your last trip. Open the app to settle it.',
        ),
      ];
    }
    default:
      return [];
  }
}

/// Both participants are told, and the copy differs by who cancelled — the
/// rider needs to know whether to rebook, and the driver needs to know they
/// are free again. Neither message carries a name, a vehicle number or a fare:
/// a notification is readable from a locked screen.
///
/// Each side reads the ride for itself, as the consumer always has, so a failed
/// read for one participant never costs the other their notification.
async function planCancelled(
  envelope: EventEnvelope,
  lookups: NotificationLookups,
): Promise<PlanOutcome[]> {
  const data = envelope.data as { rideId?: string; cancelledBy?: string };
  if (!data.rideId) {
    return [skip('customer', 'missing_ride_id'), skip('driver', 'missing_ride_id')];
  }

  const byDriver = data.cancelledBy === 'driver';
  const byCustomer = data.cancelledBy === 'customer';

  const customer = await toRideCustomer(
    envelope,
    lookups,
    data.rideId,
    'Ride cancelled',
    byDriver
      ? 'Your driver cancelled this trip. Book again and we will find you another driver.'
      : 'Your trip has been cancelled.',
  );

  let driver: PlanOutcome;
  try {
    const ride = await lookups.findRide(data.rideId);
    if (!ride) {
      driver = skip('driver', 'ride_not_found');
    } else if (!ride.driverId) {
      // `rides.driver_id` is NOT NULL; kept because the consumer always guarded it.
      driver = skip('driver', 'ride_has_no_driver');
    } else {
      driver = await toDriver(
        envelope,
        lookups,
        ride.driverId,
        'Ride cancelled',
        byCustomer
          ? 'The passenger cancelled this trip. You are back online.'
          : 'This trip has been cancelled.',
      );
    }
  } catch (error) {
    driver = { kind: 'lookup_failed', audience: 'driver', error };
  }

  return [customer, driver];
}

/// The ride-status events whose only participant is the customer of `data.rideId`.
async function toRideCustomerOf(
  envelope: EventEnvelope,
  lookups: NotificationLookups,
  title: string,
  body: string,
): Promise<PlanOutcome[]> {
  const data = envelope.data as { rideId?: string };
  if (!data.rideId) return [skip('customer', 'missing_ride_id')];
  return [await toRideCustomer(envelope, lookups, data.rideId, title, body)];
}

/// The ride is read for its customer rather than trusting the envelope.
async function toRideCustomer(
  envelope: EventEnvelope,
  lookups: NotificationLookups,
  rideId: string,
  title: string,
  body: string,
): Promise<PlanOutcome> {
  try {
    const ride = await lookups.findRide(rideId);
    if (!ride) return skip('customer', 'ride_not_found');
    return notify(envelope, 'customer', ride.customerId, title, body);
  } catch (error) {
    return { kind: 'lookup_failed', audience: 'customer', error };
  }
}

async function toDriver(
  envelope: EventEnvelope,
  lookups: NotificationLookups,
  driverId: string,
  title: string,
  body: string,
): Promise<PlanOutcome> {
  try {
    const driver = await lookups.findDriver(driverId);
    if (!driver) return skip('driver', 'driver_not_found');
    return notify(envelope, 'driver', driver.userId, title, body);
  } catch (error) {
    return { kind: 'lookup_failed', audience: 'driver', error };
  }
}

function notify(
  envelope: EventEnvelope,
  audience: NotificationAudience,
  userId: string,
  title: string,
  body: string,
): PlanOutcome {
  const priority = resolveNotificationPriority(envelope.type);
  const rideId = (envelope.data as { rideId?: string })?.rideId ?? null;
  return {
    kind: 'notify',
    plan: {
      audience,
      deliveryClass: priority.deliveryClass,
      bullMqPriority: priority.bullMqPriority,
      input: {
        userId,
        // The persistence category, not the delivery class: a ride offer is
        // TRANSACTIONAL here and RIDE_OFFER on the wire.
        category: 'TRANSACTIONAL',
        priority: priority.prismaPriority,
        eventKey: envelope.type,
        idempotencyKey: notificationIdempotencyKey(envelope, userId),
        title,
        body,
        data: buildNotificationPayload(envelope),
        referenceType: rideId ? 'RIDE' : null,
        referenceId: rideId,
        channel: 'PUSH',
      },
    },
  };
}

function skip(audience: NotificationAudience, reason: PlanSkipReason): PlanOutcome {
  return { kind: 'skip', audience, reason };
}

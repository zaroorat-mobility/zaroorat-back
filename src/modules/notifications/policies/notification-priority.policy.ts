import type { NotificationPriority } from '../../../generated/prisma';

/// The notification's *delivery class*: how urgently it must arrive and how
/// insistently it should present.
///
/// Deliberately NOT the Prisma `NotificationCategory` enum, which is
/// TRANSACTIONAL | PROMOTIONAL | SAFETY | SYSTEM and describes what the
/// notification *is* for persistence and preference purposes. This describes how
/// it must be *delivered*. The two overlap in name only, and a ride offer is a
/// clear example of the difference: `TRANSACTIONAL` in the database, `RIDE_OFFER`
/// on the wire, because it needs a 45-second TTL and a MAX-importance channel
/// that no other transactional notification wants.
export type NotificationDeliveryClass =
  'CRITICAL' | 'RIDE_OFFER' | 'TRANSACTIONAL' | 'GENERAL' | 'PROMOTIONAL';

export interface PriorityMapping {
  bullMqPriority: number; // 1 (highest) to 10 (lowest)
  prismaPriority: NotificationPriority;
  deliveryClass: NotificationDeliveryClass;
}

const EVENT_PRIORITY_MAP: Record<string, PriorityMapping> = {
  // HIGH Priority (1) - Time-sensitive operational ride events
  //
  // A dispatch offer is its own delivery class: it is the only notification
  // whose subject expires in seconds, so it is the only one that needs a short
  // TTL and a channel loud enough to reach a driver who is not holding the phone.
  'ride.dispatch.offered': {
    bullMqPriority: 1,
    prismaPriority: 'HIGH',
    deliveryClass: 'RIDE_OFFER',
  },
  'ride.accepted': { bullMqPriority: 1, prismaPriority: 'HIGH', deliveryClass: 'TRANSACTIONAL' },
  'ride.driver_arrived': {
    bullMqPriority: 1,
    prismaPriority: 'HIGH',
    deliveryClass: 'TRANSACTIONAL',
  },
  'ride.cancelled': { bullMqPriority: 1, prismaPriority: 'HIGH', deliveryClass: 'TRANSACTIONAL' },
  'sos.alert': { bullMqPriority: 1, prismaPriority: 'CRITICAL', deliveryClass: 'CRITICAL' },

  // NORMAL Priority (2) - Standard status updates & payment receipts
  'ride.driver_arriving': {
    bullMqPriority: 2,
    prismaPriority: 'NORMAL',
    deliveryClass: 'TRANSACTIONAL',
  },
  'ride.started': { bullMqPriority: 2, prismaPriority: 'NORMAL', deliveryClass: 'TRANSACTIONAL' },
  'ride.completed': { bullMqPriority: 2, prismaPriority: 'NORMAL', deliveryClass: 'TRANSACTIONAL' },
  'ride.request.expired': {
    bullMqPriority: 2,
    prismaPriority: 'NORMAL',
    deliveryClass: 'TRANSACTIONAL',
  },
  'payment.ride.collected': {
    bullMqPriority: 2,
    prismaPriority: 'NORMAL',
    deliveryClass: 'TRANSACTIONAL',
  },
  'payment.ride.collection_failed': {
    bullMqPriority: 2,
    prismaPriority: 'NORMAL',
    deliveryClass: 'TRANSACTIONAL',
  },

  // LOW Priority (3) - Marketing & promotions
  'promotional.broadcast': {
    bullMqPriority: 3,
    prismaPriority: 'LOW',
    deliveryClass: 'PROMOTIONAL',
  },
};

export function resolveNotificationPriority(eventKey?: string | null): PriorityMapping {
  if (eventKey && EVENT_PRIORITY_MAP[eventKey]) {
    return EVENT_PRIORITY_MAP[eventKey];
  }
  return { bullMqPriority: 2, prismaPriority: 'NORMAL', deliveryClass: 'TRANSACTIONAL' };
}

/// How a delivery class presents on the device, and how long FCM may keep
/// trying. Read by the delivery job from the class carried in the payload.
export interface DeliveryPresentation {
  /// Android notification channel. The app creates these with an importance;
  /// this only selects which one, so an unknown channel degrades to Android's
  /// default rather than failing — which is exactly what happens on the driver
  /// app until it creates its channels.
  channelId: string;
  /// Relative TTL. FCM's default is four weeks, which is indefensible for
  /// anything whose subject expires.
  ttlMs: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const CLASS_PRESENTATION: Record<NotificationDeliveryClass, DeliveryPresentation> = {
  // A safety alert is never collapsed and is given the longest useful window:
  // ten minutes is well past the point where a late alert stops being useful,
  // but a device that reconnects inside that window should still get it.
  CRITICAL: { channelId: 'safety', ttlMs: 10 * MINUTE },
  // Bounded by the dispatch window itself. A push that lands after the offer
  // expired can only present something the driver must not act on.
  RIDE_OFFER: { channelId: 'ride-offer', ttlMs: 45_000 },
  TRANSACTIONAL: { channelId: 'ride', ttlMs: HOUR },
  GENERAL: { channelId: 'general', ttlMs: 24 * HOUR },
  PROMOTIONAL: { channelId: 'general', ttlMs: 24 * HOUR },
};

export function resolveDeliveryPresentation(
  deliveryClass: NotificationDeliveryClass,
): DeliveryPresentation {
  return CLASS_PRESENTATION[deliveryClass] ?? CLASS_PRESENTATION.TRANSACTIONAL;
}

/// What is left of a ride offer's window at `now`, from the offer's own
/// `expiresAt` — the one expiry the dispatch service writes and the accept path
/// enforces (`RIDE_DISPATCH_TIMEOUT_SEC`, 10s by default). The fixed 45s class
/// TTL outlived that window, so FCM could deliver an offer half a minute after
/// it closed.
///
/// - `null`: no usable `expiresAt`; the caller keeps the class TTL.
/// - `expired`: the window is closed (a remaining 0ms counts as closed). The
///   offer must not be enqueued or sent.
/// - otherwise the push may live exactly as long as the offer: `ttlMs` for
///   Android, `expiresAt` for APNs.
export type OfferWindow = { expired: true } | { expired: false; ttlMs: number; expiresAt: Date };

export function resolveOfferWindow(expiresAt: unknown, now: number): OfferWindow | null {
  if (typeof expiresAt !== 'string') return null;
  const end = Date.parse(expiresAt);
  if (Number.isNaN(end)) return null;
  const remaining = end - now;
  return remaining > 0
    ? { expired: false, ttlMs: remaining, expiresAt: new Date(end) }
    : { expired: true };
}

/// Supersedes an older undelivered message about the same subject, so a rider
/// sees "your driver has arrived" rather than a stack ending at "on the way".
///
/// Returns `null` where collapsing would lose information: a safety alert must
/// never be superseded, and a notification with no subject id has nothing to
/// collapse against.
/// Payment outcomes collapse on their own key, not the ride-status key. Sharing
/// one key would let "payment received" supersede an undelivered "your driver
/// has arrived" — two different facts about the same ride, both of which the
/// rider needs.
export function resolveCollapseKey(
  deliveryClass: NotificationDeliveryClass,
  eventType: string,
  ids: { rideId?: string | undefined; dispatchId?: string | undefined },
): string | null {
  if (deliveryClass === 'CRITICAL') return null;
  if (deliveryClass === 'RIDE_OFFER') {
    return ids.dispatchId ? `offer:${ids.dispatchId}` : null;
  }
  if (!ids.rideId) return null;
  return eventType.startsWith('payment.')
    ? `ride:${ids.rideId}:payment`
    : `ride:${ids.rideId}:status`;
}

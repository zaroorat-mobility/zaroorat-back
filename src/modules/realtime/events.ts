/// The wire contract. Domain events are internal and free to change shape;
/// these names and payloads are what mobile clients pin against, so they are
/// declared once, here, and mapped to from the bridge rather than derived
/// from domain event names by string munging.
export const SOCKET_EVENT = {
  /// Server → client, sent once on a successful handshake so a client knows
  /// which principal the server resolved and which rooms it was placed in.
  READY: 'connection.ready',
  /// Server → client, for anything the client did wrong. Never throws the
  /// socket away unless the handshake itself failed.
  ERROR: 'connection.error',

  OFFER_RECEIVED: 'ride.offer.received',
  OFFER_REJECTED: 'ride.offer.rejected',
  OFFER_EXPIRED: 'ride.offer.expired',

  RIDE_REQUESTED: 'ride.requested',
  /// Server → the rider's own user room. There is no ride and never will be:
  /// the search ran out of time without a driver.
  REQUEST_EXPIRED: 'ride.request.expired',
  DRIVER_ASSIGNED: 'ride.driver.assigned',
  DRIVER_NEARBY: 'ride.driver.nearby',
  DRIVER_ARRIVING: 'ride.driver.arriving',
  DRIVER_ARRIVED: 'ride.driver.arrived',
  DRIVER_AT_DROPOFF: 'ride.driver.at_dropoff',
  RIDE_STARTED: 'ride.started',
  RIDE_COMPLETED: 'ride.completed',
  RIDE_CANCELLED: 'ride.cancelled',

  /// Server -> ride room. The outcome of collecting the fare, which happens
  /// after the ride is already over.
  PAYMENT_SETTLED: 'ride.payment.settled',
  PAYMENT_FAILED: 'ride.payment.failed',

  /// Server → ride room. The assigned driver's position, for one ride.
  DRIVER_LOCATION: 'ride.driver.location',

  /// Server → ride room. Remaining route distance and ETA refresh.
  ETA_UPDATED: 'ride.eta.updated',

  /// Server → driver + customer rooms. Upcoming scheduled pickup (T-30min).
  SCHEDULED_REMINDER: 'ride.scheduled.reminder',

  /// Server → ride room. New chat message on an active ride conversation.
  CHAT_MESSAGE_NEW: 'chat.message.new',

  /// Server → admin dashboard rooms. Invalidation hints: each names the fact
  /// that changed (ids and statuses only — never money, PII or coordinates) so
  /// the dashboard knows which permission-checked REST query to re-read.
  DASHBOARD_RIDE_CHANGED: 'dashboard.ride.changed',
  DASHBOARD_RIDE_REQUEST_CHANGED: 'dashboard.ride_request.changed',
  DASHBOARD_DRIVER_STATUS_CHANGED: 'dashboard.driver.status_changed',
  DASHBOARD_DRIVER_REGISTRATION_CHANGED: 'dashboard.driver.registration_changed',
  /// Finance room only, and carries no data at all: "the ledger moved".
  DASHBOARD_FINANCIALS_CHANGED: 'dashboard.financials.changed',
} as const;

/// Client → server.
export const CLIENT_COMMAND = {
  JOIN_RIDE: 'ride.join',
  LEAVE_RIDE: 'ride.leave',
  LOCATION_UPDATE: 'driver.location.update',
  /// Client → server. Persist + fan-out a chat message (also available via REST).
  CHAT_MESSAGE_SEND: 'chat.message.send',
  /// Client → server. Ephemeral typing indicator for the ride room.
  CHAT_TYPING: 'chat.typing',
  /// Client → server. Join the admin dashboard rooms the caller's permissions
  /// allow; the server decides which, from the database, on every call.
  DASHBOARD_SUBSCRIBE: 'dashboard.subscribe',
  DASHBOARD_UNSUBSCRIBE: 'dashboard.unsubscribe',
} as const;

export type SocketEventName = (typeof SOCKET_EVENT)[keyof typeof SOCKET_EVENT];

/// Every server→client payload carries `eventId`. It is the outbox row's event
/// id for bridged domain events, which is what lets a client discard a message
/// it has already seen — over a socket *and* via a push notification for the
/// same domain fact (see `RideNotificationConsumer`). Without it a driver whose
/// app was backgrounded during an offer gets the offer twice.
export interface SocketEnvelope<T = Record<string, unknown>> {
  eventId: string;
  type: SocketEventName;
  occurredAt: string;
  data: T;
}

export function socketEnvelope<T extends Record<string, unknown>>(
  eventId: string,
  type: SocketEventName,
  data: T,
  occurredAt = new Date(),
): SocketEnvelope<T> {
  return { eventId, type, occurredAt: occurredAt.toISOString(), data };
}

/// Room naming. Membership is decided by the server in every case; these are
/// just the canonical strings so the gateway and the bridge cannot disagree.
export const room = {
  user: (userId: string): string => `user:${userId}`,
  driver: (driverId: string): string => `driver:${driverId}`,
  ride: (rideId: string): string => `ride:${rideId}`,
  /// Every socket opened with a session's token, so revoking the session can end
  /// them. Joined by the server at connect; never reported to or requested by a client.
  session: (sessionId: string): string => `session:${sessionId}`,
  /// Admin dashboard: operational hints (operations:read) and financial hints
  /// (finance:read) are separate rooms so neither permission implies the other.
  opsDashboard: (): string => 'dashboard:ops',
  financeDashboard: (): string => 'dashboard:finance',
} as const;

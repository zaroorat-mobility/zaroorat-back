/// `RIDE_STATUS`, `RIDE_REQUEST_STATUS` and `DISPATCH_RESPONSE` used to stand
/// here: three hand-written copies of enums Prisma already generates from the
/// schema, imported by nothing. A second copy of an enum cannot be kept honest
/// — it drifts from the schema silently, and the copy of `RideStatus` had
/// already drifted into offering `REQUESTED`, `SEARCHING` and
/// `NO_DRIVERS_FOUND` as if a `Ride` could be in those states. It cannot: a
/// `Ride` row is only ever created at ACCEPTED, and those three describe the
/// request phase, which `RideRequestStatus` models properly.
///
/// Everything in this file now is a real constant with no counterpart in the
/// schema. Import the generated types for statuses.

/// Only needs to outlive a plausible client retry window, not the request
/// itself — matches RequestExpiryJob's default 5-minute window.
export const RIDE_REQUEST_IDEMPOTENCY_TTL_SECONDS = Number(
  process.env.RIDE_REQUEST_IDEMPOTENCY_TTL_SECONDS ?? 300,
);
/// A driver-submitted final distance/duration this far beyond the original
/// quote's estimate is rejected rather than trusted outright — see
/// LifecycleService.assertPlausibleTripData. Not a GPS cross-check (no trip
/// location trail is persisted anywhere in this codebase to check against),
/// just a bound against the one real reference point that already exists.
export const TRIP_DISTANCE_PLAUSIBILITY_MULTIPLIER = 3;
export const TRIP_DISTANCE_PLAUSIBILITY_BUFFER_KM = 5;
export const TRIP_DURATION_PLAUSIBILITY_MULTIPLIER = 4;
export const TRIP_DURATION_PLAUSIBILITY_BUFFER_MIN = 15;

/// D1. The payment methods a NEW ride may be booked with. The customer pays the
/// driver directly — cash, a UPI transfer, or a card — and the platform never
/// collects the fare.
///
/// WALLET is deliberately absent and must NOT be added back: the customer
/// wallet can no longer be topped up, so a new WALLET ride could only spend a
/// historical balance. It remains in the `PaymentMethod` database enum, and
/// every wallet collection/receivable/write-off path stays live, because rides
/// booked before this rule still have to be collected and settled.
export const NEW_RIDE_PAYMENT_METHODS = ['CASH', 'UPI', 'CARD'] as const;
export type NewRidePaymentMethod = (typeof NEW_RIDE_PAYMENT_METHODS)[number];

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

export const RIDE_OTP_TTL_MINUTES = 15;
export const RIDE_OTP_MAX_ATTEMPTS = 5;
export const RIDE_OTP_LENGTH = 6;
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

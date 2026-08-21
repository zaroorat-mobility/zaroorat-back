export const RIDE_STATUS = {
  REQUESTED: 'REQUESTED',
  SEARCHING: 'SEARCHING',
  ACCEPTED: 'ACCEPTED',
  DRIVER_ARRIVING: 'DRIVER_ARRIVING',
  DRIVER_ARRIVED: 'DRIVER_ARRIVED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  CANCELLED_BY_CUSTOMER: 'CANCELLED_BY_CUSTOMER',
  CANCELLED_BY_DRIVER: 'CANCELLED_BY_DRIVER',
  CANCELLED_BY_SYSTEM: 'CANCELLED_BY_SYSTEM',
  NO_DRIVERS_FOUND: 'NO_DRIVERS_FOUND',
} as const;
export type RideStatusType = (typeof RIDE_STATUS)[keyof typeof RIDE_STATUS];
export const RIDE_REQUEST_STATUS = {
  CREATED: 'CREATED',
  SEARCHING: 'SEARCHING',
  MATCHED: 'MATCHED',
  EXPIRED: 'EXPIRED',
  ABANDONED: 'ABANDONED',
} as const;
export type RideRequestStatusType = (typeof RIDE_REQUEST_STATUS)[keyof typeof RIDE_REQUEST_STATUS];
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
export const DISPATCH_RESPONSE = {
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
  TIMEOUT: 'TIMEOUT',
  CANCELLED: 'CANCELLED',
} as const;
export type DispatchResponseType = (typeof DISPATCH_RESPONSE)[keyof typeof DISPATCH_RESPONSE];

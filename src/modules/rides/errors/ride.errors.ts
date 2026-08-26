export class RideError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(message: string, code = 'RIDE_ERROR', statusCode = 400) {
    super(message);
    this.name = 'RideError';
    this.code = code;
    this.statusCode = statusCode;
  }
}
export class InvalidRideStateTransitionError extends RideError {
  constructor(fromState: string, toState: string) {
    super(
      `Cannot transition ride state from ${fromState} to ${toState}`,
      'INVALID_RIDE_STATE_TRANSITION',
      409,
    );
    this.name = 'InvalidRideStateTransitionError';
  }
}
export class ActiveRideExistsError extends RideError {
  constructor(message = 'Customer already has an active ride in progress') {
    super(message, 'ACTIVE_RIDE_EXISTS', 409);
    this.name = 'ActiveRideExistsError';
  }
}
export class OtpVerificationError extends RideError {
  constructor(message = 'Invalid or expired ride start OTP') {
    super(message, 'OTP_VERIFICATION_FAILED', 400);
    this.name = 'OtpVerificationError';
  }
}
export class RideNotFoundError extends RideError {
  constructor(id: string) {
    super(`Ride or RideRequest with ID '${id}' was not found`, 'RIDE_NOT_FOUND', 404);
    this.name = 'RideNotFoundError';
  }
}
export class RideRequestAlreadyMatchedError extends RideError {
  constructor(requestId: string) {
    super(
      `Ride request '${requestId}' has already been matched to another driver`,
      'RIDE_REQUEST_ALREADY_MATCHED',
      409,
    );
    this.name = 'RideRequestAlreadyMatchedError';
  }
}
export class RideDriverMismatchError extends RideError {
  constructor(rideId: string) {
    super(`Ride '${rideId}' is not assigned to this driver`, 'RIDE_DRIVER_MISMATCH', 403);
    this.name = 'RideDriverMismatchError';
  }
}
export class RideActorRequiredError extends RideError {
  constructor(cancelledBy: string) {
    super(
      `A ${cancelledBy} action requires an actor id to authorise it`,
      'RIDE_ACTOR_REQUIRED',
      400,
    );
    this.name = 'RideActorRequiredError';
  }
}
export class RideCustomerMismatchError extends RideError {
  constructor(rideId: string) {
    super(`Ride '${rideId}' does not belong to this customer`, 'RIDE_CUSTOMER_MISMATCH', 403);
    this.name = 'RideCustomerMismatchError';
  }
}
export class DriverNotAvailableError extends RideError {
  constructor(message = 'Driver is not available or busy on another trip') {
    super(message, 'DRIVER_NOT_AVAILABLE', 409);
    this.name = 'DriverNotAvailableError';
  }
}
export class RideRequestNotCancellableError extends RideError {
  constructor(status: string) {
    super(
      `Ride request cannot be cancelled from status '${status}'`,
      'RIDE_REQUEST_NOT_CANCELLABLE',
      409,
    );
    this.name = 'RideRequestNotCancellableError';
  }
}
export class VehicleMismatchError extends RideError {
  constructor(message: string) {
    super(message, 'VEHICLE_MISMATCH', 403);
    this.name = 'VehicleMismatchError';
  }
}
export class ImplausibleTripDataError extends RideError {
  constructor(message: string) {
    super(message, 'IMPLAUSIBLE_TRIP_DATA', 422);
    this.name = 'ImplausibleTripDataError';
  }
}
export class RideNotRatableError extends RideError {
  constructor(status: string) {
    super(
      `Only a completed ride can be rated (current status: '${status}')`,
      'RIDE_NOT_RATABLE',
      409,
    );
    this.name = 'RideNotRatableError';
  }
}
export class AlreadyRatedError extends RideError {
  constructor() {
    super('You have already rated this ride', 'ALREADY_RATED', 409);
    this.name = 'AlreadyRatedError';
  }
}
export class IncompleteProfileError extends RideError {
  constructor() {
    super('Add your name to your profile before booking a ride', 'INCOMPLETE_PROFILE', 422);
    this.name = 'IncompleteProfileError';
  }
}
/// Accepting a request used to consult nothing but the request row: any online
/// driver could accept any ride, offered to them or not, and a timed-out or
/// already-lost offer was just as acceptable as a live one. These three are the
/// vocabulary for the offer check that now guards it.
export class RideOfferNotFoundError extends RideError {
  constructor(requestId: string) {
    super(`You have no offer for ride request '${requestId}'`, 'RIDE_OFFER_NOT_FOUND', 404);
    this.name = 'RideOfferNotFoundError';
  }
}
export class RideOfferNotActionableError extends RideError {
  constructor(response: string, expired = false) {
    super(
      expired
        ? 'This ride offer has expired'
        : `This ride offer is no longer actionable (already ${response})`,
      'RIDE_OFFER_NOT_ACTIONABLE',
      409,
    );
    this.name = 'RideOfferNotActionableError';
  }
}
export class RideOfferDriverMismatchError extends RideError {
  constructor(dispatchId: string) {
    super(`Ride offer '${dispatchId}' was not made to this driver`, 'RIDE_OFFER_MISMATCH', 403);
    this.name = 'RideOfferDriverMismatchError';
  }
}
/// A driver accepting a request they themselves booked. Never a real trip: it
/// mints a completed ride, a driver earning and a commission entry out of a
/// journey nobody took. Given its own code rather than folded into
/// `DRIVER_NOT_AVAILABLE` because the two want opposite responses — a busy
/// driver is a race worth retrying, this is an attempt worth alerting on.
export class SelfRideNotAllowedError extends RideError {
  constructor() {
    super('You cannot accept a ride you requested yourself', 'SELF_RIDE_NOT_ALLOWED', 403);
    this.name = 'SelfRideNotAllowedError';
  }
}

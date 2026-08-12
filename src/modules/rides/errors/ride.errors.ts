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

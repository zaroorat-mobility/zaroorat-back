export class DriverError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(message: string, code = 'DRIVER_ERROR', statusCode = 400) {
    super(message);
    this.name = 'DriverError';
    this.code = code;
    this.statusCode = statusCode;
  }
}
export class DriverNotFoundError extends DriverError {
  constructor(identifier: string) {
    super(`Driver '${identifier}' was not found`, 'DRIVER_NOT_FOUND', 404);
    this.name = 'DriverNotFoundError';
  }
}
export class DriverNotVerifiedError extends DriverError {
  constructor(
    message = 'Driver verification status is not VERIFIED or required documents are missing',
  ) {
    super(message, 'DRIVER_NOT_VERIFIED', 403);
    this.name = 'DriverNotVerifiedError';
  }
}
export class DriverSuspendedError extends DriverError {
  constructor(message = 'Driver account is currently suspended') {
    super(message, 'DRIVER_SUSPENDED', 403);
    this.name = 'DriverSuspendedError';
  }
}
export class InvalidDriverStatusTransitionError extends DriverError {
  constructor(fromStatus: string, toStatus: string) {
    super(
      `Cannot transition driver status from ${fromStatus} to ${toStatus}`,
      'INVALID_DRIVER_STATUS_TRANSITION',
      409,
    );
    this.name = 'InvalidDriverStatusTransitionError';
  }
}
export class MockLocationRejectedError extends DriverError {
  constructor(message = 'Mock GPS location updates are rejected for driver safety and compliance') {
    super(message, 'MOCK_LOCATION_REJECTED', 400);
    this.name = 'MockLocationRejectedError';
  }
}
export class ImplausibleLocationError extends DriverError {
  readonly reason: string;
  constructor(reason: string, detail: string) {
    super(`Location update rejected as implausible: ${detail}`, 'IMPLAUSIBLE_LOCATION', 400);
    this.name = 'ImplausibleLocationError';
    this.reason = reason;
  }
}
export class DriverOnTripError extends DriverError {
  constructor(message = 'Driver cannot go offline while on an active trip') {
    super(message, 'DRIVER_ON_TRIP', 409);
    this.name = 'DriverOnTripError';
  }
}
export class DocumentValidationError extends DriverError {
  constructor(message: string) {
    super(message, 'DOCUMENT_VALIDATION_ERROR', 422);
    this.name = 'DocumentValidationError';
  }
}

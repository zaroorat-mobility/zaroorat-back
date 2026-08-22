export class VehicleError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: unknown;
  constructor(message: string, code = 'VEHICLE_ERROR', statusCode = 400, details?: unknown) {
    super(message);
    this.name = 'VehicleError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class VehicleAlreadyAssignedError extends VehicleError {
  constructor(registrationNumber: string) {
    super(
      `Vehicle '${registrationNumber}' is already assigned to another driver`,
      'VEHICLE_ALREADY_ASSIGNED',
      409,
    );
    this.name = 'VehicleAlreadyAssignedError';
  }
}

export class VehicleNotFoundError extends VehicleError {
  constructor(identifier: string) {
    super(`Vehicle '${identifier}' was not found`, 'VEHICLE_NOT_FOUND', 404);
    this.name = 'VehicleNotFoundError';
  }
}

export class VehicleTypeNotFoundError extends VehicleError {
  constructor(identifier: string) {
    super(`Vehicle type '${identifier}' was not found`, 'VEHICLE_TYPE_NOT_FOUND', 404);
    this.name = 'VehicleTypeNotFoundError';
  }
}

export class VehicleTypeInactiveError extends VehicleError {
  constructor(identifier: string) {
    super(
      `Vehicle type '${identifier}' is not available for service`,
      'VEHICLE_TYPE_INACTIVE',
      409,
    );
    this.name = 'VehicleTypeInactiveError';
  }
}

/// The caller holds no ACTIVE assignment on the vehicle they are acting on.
/// 404 rather than 403, matching `FileNotFoundError`'s reasoning: a 403 would
/// confirm the vehicle exists to somebody with no claim on it.
export class VehicleNotOwnedError extends VehicleError {
  constructor(vehicleId: string) {
    super(`Vehicle '${vehicleId}' was not found`, 'VEHICLE_NOT_FOUND', 404);
    this.name = 'VehicleNotOwnedError';
  }
}

export class NoActiveVehicleError extends VehicleError {
  constructor(message = 'Driver has no vehicle assigned') {
    super(message, 'VEHICLE_MISSING', 409);
    this.name = 'NoActiveVehicleError';
  }
}

export class VehicleInactiveError extends VehicleError {
  constructor(message = 'The assigned vehicle is not active') {
    super(message, 'VEHICLE_INACTIVE', 409);
    this.name = 'VehicleInactiveError';
  }
}

export class VehicleNotVerifiedError extends VehicleError {
  constructor(
    message = 'The assigned vehicle has not completed operator verification',
    details?: unknown,
  ) {
    super(message, 'VEHICLE_NOT_VERIFIED', 403, details);
    this.name = 'VehicleNotVerifiedError';
  }
}

export class VehicleDocumentsIncompleteError extends VehicleError {
  constructor(
    message = 'The assigned vehicle does not hold every required document',
    details?: unknown,
  ) {
    super(message, 'VEHICLE_DOCUMENTS_INCOMPLETE', 403, details);
    this.name = 'VehicleDocumentsIncompleteError';
  }
}

export class UnknownVehicleDocumentTypeError extends VehicleError {
  constructor(documentType: string, allowed: readonly string[]) {
    super(
      `Unknown vehicle document type '${documentType}'. Allowed: ${allowed.join(', ')}`,
      'VEHICLE_DOCUMENT_TYPE_INVALID',
      400,
    );
    this.name = 'UnknownVehicleDocumentTypeError';
  }
}

export class VehicleDocumentNotFoundError extends VehicleError {
  constructor(documentId: string) {
    super(`Vehicle document '${documentId}' was not found`, 'VEHICLE_DOCUMENT_NOT_FOUND', 404);
    this.name = 'VehicleDocumentNotFoundError';
  }
}

export class VehicleDocumentMismatchError extends VehicleError {
  constructor() {
    super('Document does not belong to the specified vehicle', 'VEHICLE_DOCUMENT_MISMATCH', 409);
    this.name = 'VehicleDocumentMismatchError';
  }
}

/// Mirrors `SelfReviewForbiddenError` in the drivers module: an operator who
/// also drives must not approve the vehicle they themselves operate.
export class SelfVehicleReviewForbiddenError extends VehicleError {
  constructor(message = 'You cannot review a vehicle assigned to you') {
    super(message, 'SELF_REVIEW_FORBIDDEN', 403);
    this.name = 'SelfVehicleReviewForbiddenError';
  }
}

export class VehicleInUseError extends VehicleError {
  constructor(message = 'The vehicle is on an active ride and cannot be released') {
    super(message, 'VEHICLE_IN_USE', 409);
    this.name = 'VehicleInUseError';
  }
}

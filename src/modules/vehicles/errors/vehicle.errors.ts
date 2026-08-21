export class VehicleError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(message: string, code = 'VEHICLE_ERROR', statusCode = 400) {
    super(message);
    this.name = 'VehicleError';
    this.code = code;
    this.statusCode = statusCode;
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

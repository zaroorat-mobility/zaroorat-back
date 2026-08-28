export class AdminVehicleError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(message: string, code = 'VEHICLE_ADMIN_ERROR', statusCode = 400) {
    super(message);
    this.name = 'AdminVehicleError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class AdminVehicleNotFoundError extends AdminVehicleError {
  constructor(message = 'Vehicle was not found') {
    super(message, 'VEHICLE_NOT_FOUND', 404);
    this.name = 'AdminVehicleNotFoundError';
  }
}

export class AdminVehicleConflictError extends AdminVehicleError {
  constructor(message: string) {
    super(message, 'VEHICLE_CONFLICT', 409);
    this.name = 'AdminVehicleConflictError';
  }
}

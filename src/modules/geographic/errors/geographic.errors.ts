export class GeographicError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(message: string, code = 'GEOGRAPHIC_ERROR', statusCode = 400) {
    super(message);
    this.name = 'GeographicError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class OutsideServiceAreaError extends GeographicError {
  constructor(message = 'Pickup is outside the service area') {
    super(message, 'OUTSIDE_SERVICE_AREA', 400);
    this.name = 'OutsideServiceAreaError';
  }
}

export class RestrictedZoneError extends GeographicError {
  constructor(message = 'Pickup is in a restricted zone') {
    super(message, 'RESTRICTED_ZONE', 400);
    this.name = 'RestrictedZoneError';
  }
}

export class OutsideServiceZoneError extends GeographicError {
  constructor(message = 'Pickup is outside an active service zone') {
    super(message, 'OUTSIDE_SERVICE_ZONE', 400);
    this.name = 'OutsideServiceZoneError';
  }
}

export class VehicleNotSupportedInZoneError extends GeographicError {
  constructor(message = 'Vehicle type is not supported in this zone') {
    super(message, 'VEHICLE_NOT_SUPPORTED_IN_ZONE', 400);
    this.name = 'VehicleNotSupportedInZoneError';
  }
}

export class DropOutsideServiceAreaError extends GeographicError {
  constructor(message = 'Drop-off is outside the service area') {
    super(message, 'DROP_OUTSIDE_SERVICE_AREA', 400);
    this.name = 'DropOutsideServiceAreaError';
  }
}

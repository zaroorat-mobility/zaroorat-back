// ---------------------------------------------------------------------------
// Raw coordinate / spatial errors (formerly geo.errors.ts)
// ---------------------------------------------------------------------------

export class GeoError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(message: string, code = 'GEO_ERROR', statusCode = 400) {
    super(message);
    this.name = 'GeoError';
    this.code = code;
    this.statusCode = statusCode;
  }
}
export class InvalidCoordinateError extends GeoError {
  constructor(latitude: unknown, longitude: unknown, detail?: string) {
    super(
      `(${String(latitude)}, ${String(longitude)}) is not a valid coordinate${detail ? `: ${detail}` : ''}`,
      'GEO_INVALID_COORDINATE',
      400,
    );
    this.name = 'InvalidCoordinateError';
  }
}
export class InvalidSearchRadiusError extends GeoError {
  constructor(requested: number, max: number) {
    super(
      `Search radius ${requested}m exceeds the maximum of ${max}m`,
      'GEO_RADIUS_TOO_LARGE',
      400,
    );
    this.name = 'InvalidSearchRadiusError';
  }
}
export class InvalidH3CellError extends GeoError {
  constructor(cell: string) {
    super(`'${cell}' is not a valid H3 cell`, 'GEO_INVALID_H3_CELL', 400);
    this.name = 'InvalidH3CellError';
  }
}

// ---------------------------------------------------------------------------
// Business / service-zone errors (formerly geographic.errors.ts)
// ---------------------------------------------------------------------------

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

export class RoutingProviderUnavailableError extends GeographicError {
  constructor(message = 'Unable to calculate trip route distance and ETA. Please try again.') {
    super(message, 'ROUTING_PROVIDER_UNAVAILABLE', 503);
    this.name = 'RoutingProviderUnavailableError';
  }
}

export class MapProviderAuthError extends GeographicError {
  constructor(message = 'Map provider authentication failed') {
    super(message, 'MAP_PROVIDER_AUTH_FAILED', 502);
    this.name = 'MapProviderAuthError';
  }
}

export class MapProviderQuotaError extends GeographicError {
  constructor(message = 'Map provider quota exceeded') {
    super(message, 'MAP_PROVIDER_QUOTA_EXCEEDED', 429);
    this.name = 'MapProviderQuotaError';
  }
}

export class MapProviderTimeoutError extends GeographicError {
  constructor(message = 'Map provider request timed out') {
    super(message, 'MAP_PROVIDER_TIMEOUT', 504);
    this.name = 'MapProviderTimeoutError';
  }
}

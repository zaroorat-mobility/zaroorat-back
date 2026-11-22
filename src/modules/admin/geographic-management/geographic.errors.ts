export class GeographicAdminError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(message: string, code = 'GEOGRAPHIC_ADMIN_ERROR', statusCode = 400) {
    super(message);
    this.name = 'GeographicAdminError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class CityNotFoundError extends GeographicAdminError {
  constructor(message = 'City was not found') {
    super(message, 'CITY_NOT_FOUND', 404);
    this.name = 'CityNotFoundError';
  }
}

export class StateNotFoundError extends GeographicAdminError {
  constructor(message = 'State was not found') {
    super(message, 'STATE_NOT_FOUND', 404);
    this.name = 'StateNotFoundError';
  }
}

export class ServiceZoneNotFoundError extends GeographicAdminError {
  constructor(message = 'Service zone was not found') {
    super(message, 'SERVICE_ZONE_NOT_FOUND', 404);
    this.name = 'ServiceZoneNotFoundError';
  }
}

export class GeographicValidationError extends GeographicAdminError {
  constructor(message: string) {
    super(message, 'GEOGRAPHIC_VALIDATION', 400);
    this.name = 'GeographicValidationError';
  }
}

export class GeographicConflictError extends GeographicAdminError {
  constructor(message: string) {
    super(message, 'GEOGRAPHIC_CONFLICT', 409);
    this.name = 'GeographicConflictError';
  }
}

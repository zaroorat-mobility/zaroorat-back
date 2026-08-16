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

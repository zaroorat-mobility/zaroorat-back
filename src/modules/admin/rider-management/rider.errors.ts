export class RiderError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(message: string, code = 'RIDER_ERROR', statusCode = 400) {
    super(message);
    this.name = 'RiderError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class RiderNotFoundError extends RiderError {
  constructor(message = 'Rider was not found') {
    super(message, 'RIDER_NOT_FOUND', 404);
    this.name = 'RiderNotFoundError';
  }
}

export class RiderConflictError extends RiderError {
  constructor(message: string) {
    super(message, 'RIDER_CONFLICT', 409);
    this.name = 'RiderConflictError';
  }
}

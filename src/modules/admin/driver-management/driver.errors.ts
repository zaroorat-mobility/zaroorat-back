export class AdminDriverError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(message: string, code = 'DRIVER_ADMIN_ERROR', statusCode = 400) {
    super(message);
    this.name = 'AdminDriverError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class AdminDriverNotFoundError extends AdminDriverError {
  constructor(message = 'Driver was not found') {
    super(message, 'DRIVER_NOT_FOUND', 404);
    this.name = 'AdminDriverNotFoundError';
  }
}

export class AdminDriverConflictError extends AdminDriverError {
  constructor(message: string) {
    super(message, 'DRIVER_CONFLICT', 409);
    this.name = 'AdminDriverConflictError';
  }
}

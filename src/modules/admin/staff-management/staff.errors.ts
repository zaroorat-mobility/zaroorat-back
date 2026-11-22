export class StaffError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(message: string, code = 'STAFF_ERROR', statusCode = 400) {
    super(message);
    this.name = 'StaffError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class StaffNotFoundError extends StaffError {
  constructor(message = 'Staff user was not found') {
    super(message, 'STAFF_NOT_FOUND', 404);
    this.name = 'StaffNotFoundError';
  }
}

export class StaffConflictError extends StaffError {
  constructor(message: string) {
    super(message, 'STAFF_CONFLICT', 409);
    this.name = 'StaffConflictError';
  }
}

export class StaffForbiddenError extends StaffError {
  constructor(message: string) {
    super(message, 'STAFF_FORBIDDEN', 403);
    this.name = 'StaffForbiddenError';
  }
}

export class RbacError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(message: string, code = 'RBAC_ERROR', statusCode = 400) {
    super(message);
    this.name = 'RbacError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class RbacForbiddenError extends RbacError {
  constructor(message: string) {
    super(message, 'RBAC_FORBIDDEN', 403);
    this.name = 'RbacForbiddenError';
  }
}

export class RbacNotFoundError extends RbacError {
  constructor(message = 'Role was not found') {
    super(message, 'RBAC_NOT_FOUND', 404);
    this.name = 'RbacNotFoundError';
  }
}

export class RbacConflictError extends RbacError {
  constructor(message: string) {
    super(message, 'RBAC_CONFLICT', 409);
    this.name = 'RbacConflictError';
  }
}

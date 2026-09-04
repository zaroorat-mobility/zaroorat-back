export class FinanceAdminError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(message: string, code = 'FINANCE_ADMIN_ERROR', statusCode = 400) {
    super(message);
    this.name = 'FinanceAdminError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class FinanceNotFoundError extends FinanceAdminError {
  constructor(message = 'Resource was not found') {
    super(message, 'FINANCE_NOT_FOUND', 404);
    this.name = 'FinanceNotFoundError';
  }
}

export class FinanceConflictError extends FinanceAdminError {
  constructor(message: string) {
    super(message, 'FINANCE_CONFLICT', 409);
    this.name = 'FinanceConflictError';
  }
}

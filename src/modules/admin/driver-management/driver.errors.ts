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

export class BankAccountNotFoundError extends AdminDriverError {
  constructor() {
    super('Bank account was not found for this driver', 'BANK_ACCOUNT_NOT_FOUND', 404);
    this.name = 'BankAccountNotFoundError';
  }
}

export class BankAccountTransitionError extends AdminDriverError {
  constructor(from: string, action: string) {
    super(
      `Cannot ${action} a bank account that is ${from}`,
      'BANK_ACCOUNT_INVALID_TRANSITION',
      409,
    );
    this.name = 'BankAccountTransitionError';
  }
}

/// Separation of duties: whoever entered or last changed the details cannot
/// be the one who verifies them.
export class BankAccountSameActorError extends AdminDriverError {
  constructor() {
    super(
      'A bank account must be verified by someone other than the person who entered it',
      'BANK_ACCOUNT_SAME_ACTOR',
      403,
    );
    this.name = 'BankAccountSameActorError';
  }
}

export class BankAccountSecurityNotReadyError extends AdminDriverError {
  constructor(message: string) {
    super(message, 'BANK_ACCOUNT_SECURITY_NOT_READY', 409);
    this.name = 'BankAccountSecurityNotReadyError';
  }
}

export class AdminDriverConflictError extends AdminDriverError {
  constructor(message: string) {
    super(message, 'DRIVER_CONFLICT', 409);
    this.name = 'AdminDriverConflictError';
  }
}

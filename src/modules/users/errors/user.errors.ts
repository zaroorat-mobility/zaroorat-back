export interface ErrorDetail {
  field: string;
  code: string;
  limit?: number;
}
export class UserError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: ErrorDetail[],
  ) {
    super(message);
    this.name = new.target.name;
  }
}
export class ImmutableFieldError extends UserError {
  constructor(fields: string[]) {
    super(
      'IMMUTABLE_FIELD',
      'One or more fields cannot be changed through this endpoint',
      fields.map((field) => ({ field, code: 'IMMUTABLE' })),
    );
  }
}
export class UserValidationError extends UserError {
  constructor(details: ErrorDetail[]) {
    super('VALIDATION', 'Request validation failed', details);
  }
}
export class UserNotFoundError extends UserError {
  constructor(message = 'The requested resource was not found') {
    super('NOT_FOUND', message);
  }
}
export class PhoneUnchangedError extends UserError {
  constructor(message = 'The new number is the same as the current one') {
    super('PHONE_UNCHANGED', message, [{ field: 'newPhoneNumber', code: 'NOT_ALLOWED' }]);
  }
}
export class PhoneInUseError extends UserError {
  constructor(message = 'That number is already registered to another account') {
    super('PHONE_IN_USE', message, [{ field: 'newPhoneNumber', code: 'NOT_ALLOWED' }]);
  }
}
export class EmailInUseError extends UserError {
  constructor(message = 'That email is already registered to another account') {
    super('EMAIL_IN_USE', message, [{ field: 'email', code: 'NOT_ALLOWED' }]);
  }
}
export class LimitExceededError extends UserError {
  constructor(field: string, limit: number) {
    super('LIMIT_EXCEEDED', 'This collection is full; remove an item before adding another', [
      { field, code: 'LIMIT_EXCEEDED', limit },
    ]);
  }
}
export class LabelConflictError extends UserError {
  constructor(message = 'You already have a saved place with that label') {
    super('CONFLICT', message, [{ field: 'label', code: 'NOT_ALLOWED' }]);
  }
}
export class AccountNotDeactivatedError extends UserError {
  constructor(message = 'This account is not deactivated, so there is nothing to restore') {
    super('CONFLICT', message, [{ field: 'status', code: 'NOT_ALLOWED' }]);
  }
}
export class AccountHasObligationsError extends UserError {
  constructor(
    obligations: {
      module: string;
      code: string;
    }[],
  ) {
    super(
      'ACCOUNT_HAS_OBLIGATIONS',
      'This account still has something in flight and cannot be closed yet',
      obligations.map((obligation) => ({ field: obligation.module, code: obligation.code })),
    );
  }
}

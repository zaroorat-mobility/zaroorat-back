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
/// A wrong `currentPin` on the change path.
///
/// Says nothing about whether a PIN is configured at all, deliberately: the two
/// answers together would let anyone holding a stolen session establish whether
/// the account has a PIN before guessing at it.
export class RidePinInvalidError extends UserError {
  constructor(message = 'The current PIN entered is not correct') {
    super('RIDE_PIN_INVALID', message, [{ field: 'currentPin', code: 'NOT_ALLOWED' }]);
  }
}
/// A PIN on the blocklist. Distinct from `VALIDATION`, which covers shape —
/// `12ab` is malformed, `1234` is well-formed and refused on its merits, and a
/// rider needs to be told which.
export class RidePinWeakError extends UserError {
  constructor(message = 'Choose a less predictable PIN — avoid repeated digits and runs') {
    super('RIDE_PIN_WEAK', message, [{ field: 'newPin', code: 'NOT_ALLOWED' }]);
  }
}
/// The change path requires the current PIN; the first-set path must not. Raised
/// when a caller who already has a PIN omits it.
export class RidePinAlreadySetError extends UserError {
  constructor(message = 'A Ride PIN is already set; provide the current one to change it') {
    super('RIDE_PIN_ALREADY_SET', message, [{ field: 'currentPin', code: 'REQUIRED' }]);
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

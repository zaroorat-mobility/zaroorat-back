/**
 * USER domain errors (user doc 04 §2). Each carries a stable `code` from the
 * error catalog; the HTTP mapping is applied by the controllers via
 * `userErrorStatus`. Throwing these keeps services transport-agnostic, matching
 * the AUTH module's `AuthError` contract.
 *
 * `details` follows doc 04 §6: `{ field, code }` pairs from a fixed vocabulary
 * and **never** a submitted value — error bodies reach crash reports and support
 * screenshots, so a personal value placed here escapes the platform (doc 04 §5).
 */

/** A field-level error detail. Carries no submitted value, by rule. */
export interface ErrorDetail {
  /** The offending field name. */
  field: string;
  /** A code from the doc 04 §6 vocabulary (e.g. `MUST_BE_PAST`). */
  code: string;
  /**
   * The configured cap, on `LIMIT_EXCEEDED` only.
   *
   * Doc 04 §1 says `details` carries "the cap on `LIMIT_EXCEEDED`" and §3 wants
   * the client to render "5 of 5 used" without hard-coding a number that lives in
   * config (R-USER-26), but neither names a shape. A number here is the smallest
   * one that satisfies both. It is not a submitted value, so §5 is unaffected.
   */
  limit?: number;
}

/** Base class for every USER domain failure. */
export class UserError extends Error {
  /**
   * @param code Stable machine code (e.g. `IMMUTABLE_FIELD`).
   * @param message Human-readable summary; never contains a submitted value.
   * @param details Optional field-level breakdown (doc 04 §6).
   */
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: ErrorDetail[],
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * A request body carried a field this module never lets a user set (doc 04 §2.1,
 * USER-INV-5). Rejected explicitly rather than silently dropped: a client that
 * believed it set a field must learn that it did not.
 */
export class ImmutableFieldError extends UserError {
  /** @param fields The offending field names, in body order. */
  constructor(fields: string[]) {
    super(
      'IMMUTABLE_FIELD',
      'One or more fields cannot be changed through this endpoint',
      fields.map((field) => ({ field, code: 'IMMUTABLE' })),
    );
  }
}

/** A request body failed schema validation (doc 04 §2.2). */
export class UserValidationError extends UserError {
  /** @param details Field-level codes from the doc 04 §6 vocabulary. */
  constructor(details: ErrorDetail[]) {
    super('VALIDATION', 'Request validation failed', details);
  }
}

/**
 * The scoped query returned no row — the resource does not exist **or is not
 * owned** (doc 04 §2.1, R-USER-25). The two cases are deliberately
 * indistinguishable: a `403` would confirm that someone else's row exists.
 */
export class UserNotFoundError extends UserError {
  constructor(message = 'The requested resource was not found') {
    super('NOT_FOUND', message);
  }
}

/**
 * A phone-change request named the number the account already holds (doc 04 §2.1).
 *
 * Rejected rather than treated as a no-op: sending an OTP to the current number
 * would spend the user's rate-limit budget and end in a change that changes
 * nothing, while a silent `202` would have the client wait for a code that proves
 * nothing.
 */
export class PhoneUnchangedError extends UserError {
  constructor(message = 'The new number is the same as the current one') {
    super('PHONE_UNCHANGED', message, [{ field: 'newPhoneNumber', code: 'NOT_ALLOWED' }]);
  }
}

/**
 * The target number belongs to another **active** account (doc 04 §2.1, 03 §4.2).
 *
 * This deliberately confirms that a number is registered — the one place the
 * platform does so. The caller is already authenticated, cannot proceed without
 * knowing, and is rate-limited per account (doc 02 §2.4.1). Raised both by the
 * step-1 pre-check and by the unique-index violation that settles a race at
 * step 2; the client cannot tell which, and does not need to.
 */
export class PhoneInUseError extends UserError {
  constructor(message = 'That number is already registered to another account') {
    super('PHONE_IN_USE', message, [{ field: 'newPhoneNumber', code: 'NOT_ALLOWED' }]);
  }
}

/**
 * A per-user collection cap is full (doc 04 §2.1, R-USER-22/24/26).
 *
 * Recoverable by deleting something, which is why the cap travels in `details`:
 * the copy can say "5 of 5 used" without the client hard-coding a number that
 * lives in configuration (doc 04 §3).
 */
export class LimitExceededError extends UserError {
  /**
   * @param field The collection that is full (`emergencyContacts` | `savedPlaces`).
   * @param limit The configured cap that was reached.
   */
  constructor(field: string, limit: number) {
    super('LIMIT_EXCEEDED', 'This collection is full; remove an item before adding another', [
      { field, code: 'LIMIT_EXCEEDED', limit },
    ]);
  }
}

/**
 * A saved-place label already exists for this user, case-insensitively
 * (doc 02 §2.6, enforced by `uq_saved_places_user_label`).
 *
 * Trivially recoverable — the user renames and retries — so doc 04 §3 is explicit
 * that this must never carry security-flavoured copy, unlike the other two 409s.
 */
export class LabelConflictError extends UserError {
  constructor(message = 'You already have a saved place with that label') {
    super('CONFLICT', message, [{ field: 'label', code: 'NOT_ALLOWED' }]);
  }
}

/**
 * A restore was attempted on an account that is not self-deactivated
 * (R-USER-17, doc 05 §3.3).
 *
 * Doc 04 §2.1 defines no code for this, because doc 02 exposes no endpoint that
 * can raise it — the restore is the `admin` module's flow. `CONFLICT` is the
 * catalogue's generic state conflict (409), and this is one: the account is not
 * in the state the operation presumes. It carries no security-flavoured copy,
 * per doc 04 §3.
 *
 * An account returning from ops **suspension** is not this operation at all —
 * that is AUTH's `activate`, and it emits AUTH's `account.reactivated`.
 */
export class AccountNotDeactivatedError extends UserError {
  constructor(message = 'This account is not deactivated, so there is nothing to restore') {
    super('CONFLICT', message, [{ field: 'status', code: 'NOT_ALLOWED' }]);
  }
}

/**
 * The account still has something in flight — an active ride, an unsettled wallet
 * balance, an open dispute (doc 04 §2.1, R-USER-21).
 *
 * Not the user's mistake at all, which is why doc 04 §3 singles it out among the
 * three 409s: `details` names the **blocking module** so the client can link
 * straight to it. `field` carries that module name rather than a request field —
 * nothing in this error refers to the body, because the body was fine.
 */
export class AccountHasObligationsError extends UserError {
  /** @param obligations One entry per blocking module, with its coarse reason. */
  constructor(obligations: { module: string; code: string }[]) {
    super(
      'ACCOUNT_HAS_OBLIGATIONS',
      'This account still has something in flight and cannot be closed yet',
      obligations.map((obligation) => ({ field: obligation.module, code: obligation.code })),
    );
  }
}

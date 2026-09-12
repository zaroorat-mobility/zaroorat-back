export class RideError extends Error {
  readonly code: string;
  readonly statusCode: number;
  /// Machine-readable extras for the client, forwarded verbatim by
  /// `handleRideError`. `errorEnvelope` and `isCodedError` have always carried
  /// this; ride errors simply had nothing to put in it until a throttled
  /// response needed to say *when* to try again.
  readonly details?: unknown;
  constructor(message: string, code = 'RIDE_ERROR', statusCode = 400, details?: unknown) {
    super(message);
    this.name = 'RideError';
    this.code = code;
    this.statusCode = statusCode;
    if (details !== undefined) this.details = details;
  }
}
export class InvalidRideStateTransitionError extends RideError {
  constructor(fromState: string, toState: string) {
    super(
      `Cannot transition ride state from ${fromState} to ${toState}`,
      'INVALID_RIDE_STATE_TRANSITION',
      409,
    );
    this.name = 'InvalidRideStateTransitionError';
  }
}
export class ActiveRideExistsError extends RideError {
  constructor(message = 'Customer already has an active ride in progress') {
    super(message, 'ACTIVE_RIDE_EXISTS', 409);
    this.name = 'ActiveRideExistsError';
  }
}
/// A wrong Ride PIN — and, deliberately, also a rider who has no PIN set at all.
///
/// The two must be one answer with one message and one status. Splitting them
/// would turn the start endpoint into an oracle: a driver could work out which
/// riders have no PIN configured and target exactly those accounts. The equal
/// timing that backs this up comes from `verifyRidePin`, which does the same
/// scrypt work against a dummy verifier when none is stored.
export class RidePinInvalidError extends RideError {
  constructor(message = 'The PIN entered is not correct') {
    super(message, 'RIDE_PIN_INVALID', 400);
    this.name = 'RidePinInvalidError';
  }
}
/// Some attempt budget is spent — the ride's, the rider's, or the driver's.
/// Which one is deliberately not said: naming it would tell an attacker which
/// dimension to switch.
export class RidePinLockedError extends RideError {
  constructor(retryAfterSeconds: number) {
    super(
      `Too many incorrect attempts. Try again in ${Math.max(1, Math.ceil(retryAfterSeconds / 60))} minute(s)`,
      'RIDE_PIN_LOCKED',
      429,
      { retryAfterSec: retryAfterSeconds },
    );
    this.name = 'RidePinLockedError';
  }
}
export class RidePinThrottledError extends RideError {
  constructor(retryAfterSeconds: number) {
    super('Please wait a moment before trying again', 'RIDE_PIN_THROTTLED', 429, {
      retryAfterSec: retryAfterSeconds,
    });
    this.name = 'RidePinThrottledError';
  }
}
/// The throttle store is unreachable, so no attempt budget can be consulted.
///
/// Fails closed, matching every other security store in this codebase — the auth
/// plugin refuses a request it cannot check revocation, permissions, device
/// state or driver operability for. Failing open here would drop brute-force
/// protection at exactly the moment monitoring is already degraded, and a Redis
/// outage is in any case a platform-wide one: dispatch locks, the trip meter and
/// idempotency all stop with it, so rides are not starting cleanly regardless.
export class RidePinUnavailableError extends RideError {
  constructor(message = 'Ride start is temporarily unavailable') {
    super(message, 'SERVICE_UNAVAILABLE', 503);
    this.name = 'RidePinUnavailableError';
  }
}
export class RideNotFoundError extends RideError {
  constructor(id: string) {
    super(`Ride or RideRequest with ID '${id}' was not found`, 'RIDE_NOT_FOUND', 404);
    this.name = 'RideNotFoundError';
  }
}
export class RideRequestAlreadyMatchedError extends RideError {
  constructor(requestId: string) {
    super(
      `Ride request '${requestId}' has already been matched to another driver`,
      'RIDE_REQUEST_ALREADY_MATCHED',
      409,
    );
    this.name = 'RideRequestAlreadyMatchedError';
  }
}
export class RideDriverMismatchError extends RideError {
  constructor(rideId: string) {
    super(`Ride '${rideId}' is not assigned to this driver`, 'RIDE_DRIVER_MISMATCH', 403);
    this.name = 'RideDriverMismatchError';
  }
}
export class RideActorRequiredError extends RideError {
  constructor(cancelledBy: string) {
    super(
      `A ${cancelledBy} action requires an actor id to authorise it`,
      'RIDE_ACTOR_REQUIRED',
      400,
    );
    this.name = 'RideActorRequiredError';
  }
}
export class RideCustomerMismatchError extends RideError {
  constructor(rideId: string) {
    super(`Ride '${rideId}' does not belong to this customer`, 'RIDE_CUSTOMER_MISMATCH', 403);
    this.name = 'RideCustomerMismatchError';
  }
}
export class DriverNotAvailableError extends RideError {
  constructor(message = 'Driver is not available or busy on another trip') {
    super(message, 'DRIVER_NOT_AVAILABLE', 409);
    this.name = 'DriverNotAvailableError';
  }
}
export class RideRequestNotCancellableError extends RideError {
  constructor(status: string) {
    super(
      `Ride request cannot be cancelled from status '${status}'`,
      'RIDE_REQUEST_NOT_CANCELLABLE',
      409,
    );
    this.name = 'RideRequestNotCancellableError';
  }
}
export class VehicleMismatchError extends RideError {
  constructor(message: string) {
    super(message, 'VEHICLE_MISMATCH', 403);
    this.name = 'VehicleMismatchError';
  }
}
export class ImplausibleTripDataError extends RideError {
  constructor(message: string) {
    super(message, 'IMPLAUSIBLE_TRIP_DATA', 422);
    this.name = 'ImplausibleTripDataError';
  }
}
export class RideNotRatableError extends RideError {
  constructor(status: string) {
    super(
      `Only a completed ride can be rated (current status: '${status}')`,
      'RIDE_NOT_RATABLE',
      409,
    );
    this.name = 'RideNotRatableError';
  }
}
export class AlreadyRatedError extends RideError {
  constructor() {
    super('You have already rated this ride', 'ALREADY_RATED', 409);
    this.name = 'AlreadyRatedError';
  }
}
export class IncompleteProfileError extends RideError {
  constructor() {
    super('Add your name to your profile before booking a ride', 'INCOMPLETE_PROFILE', 422);
    this.name = 'IncompleteProfileError';
  }
}
/// Refused at booking, never at the kerb.
///
/// A rider with no Ride PIN cannot prove who they are to their driver, so the
/// ride could never legally start. Discovering that at the pickup point — driver
/// and passenger already face to face, meter waiting — has no good outcome; the
/// same fact at booking time costs ten seconds in an app the rider is already
/// holding. Deliberately the same shape as `IncompleteProfileError`, in the same
/// guard block, for the same reason.
export class RidePinNotConfiguredError extends RideError {
  constructor() {
    super('Set your Ride PIN before booking a ride', 'RIDE_PIN_NOT_CONFIGURED', 422);
    this.name = 'RidePinNotConfiguredError';
  }
}
/// Accepting a request used to consult nothing but the request row: any online
/// driver could accept any ride, offered to them or not, and a timed-out or
/// already-lost offer was just as acceptable as a live one. These three are the
/// vocabulary for the offer check that now guards it.
export class RideOfferNotFoundError extends RideError {
  constructor(requestId: string) {
    super(`You have no offer for ride request '${requestId}'`, 'RIDE_OFFER_NOT_FOUND', 404);
    this.name = 'RideOfferNotFoundError';
  }
}
export class RideOfferNotActionableError extends RideError {
  constructor(response: string, expired = false) {
    super(
      expired
        ? 'This ride offer has expired'
        : `This ride offer is no longer actionable (already ${response})`,
      'RIDE_OFFER_NOT_ACTIONABLE',
      409,
    );
    this.name = 'RideOfferNotActionableError';
  }
}
export class RideOfferDriverMismatchError extends RideError {
  constructor(dispatchId: string) {
    super(`Ride offer '${dispatchId}' was not made to this driver`, 'RIDE_OFFER_MISMATCH', 403);
    this.name = 'RideOfferDriverMismatchError';
  }
}
/// A driver accepting a request they themselves booked. Never a real trip: it
/// mints a completed ride, a driver earning and a commission entry out of a
/// journey nobody took. Given its own code rather than folded into
/// `DRIVER_NOT_AVAILABLE` because the two want opposite responses — a busy
/// driver is a race worth retrying, this is an attempt worth alerting on.
export class SelfRideNotAllowedError extends RideError {
  constructor() {
    super('You cannot accept a ride you requested yourself', 'SELF_RIDE_NOT_ALLOWED', 403);
    this.name = 'SelfRideNotAllowedError';
  }
}
/// A promo code the platform cannot honour.
///
/// `Promotion` and `PromotionRedemption` are fully modelled — discount type,
/// caps, validity window, per-user limits — and referenced nowhere in `src`.
/// Redeeming them is an explicit non-goal of the payment feature
/// (`specs/002-payment-fare-settlement/spec.md` lists promotions and coupons
/// out of scope; `data-model.md` records that `discountAmount` stays zero).
///
/// The API accepted the code anyway, stored it on the request, and billed the
/// customer in full without ever mentioning it. Refusing is the honest answer
/// until something can apply one: a rider who typed a code and is quietly
/// charged the undiscounted fare has been overcharged from where they sit.
///
/// Delete this the day a redemption path exists; the field and the column are
/// already in place for it.
/// 004-driver-subscription-wallet. spec.md FR-000 — a driver with no payment
/// model selected is ineligible for any ride under either model.
export class PaymentModelNotSelectedError extends RideError {
  constructor() {
    super(
      'Select a payment model (SUBSCRIPTION or COMMISSION) before accepting rides',
      'PAYMENT_MODEL_NOT_SELECTED',
      409,
    );
    this.name = 'PaymentModelNotSelectedError';
  }
}
/// spec.md FR-004 — a subscription-model driver with no active, unexpired
/// subscription cannot be offered/accept a NEW ride. Never applied to a
/// commission-model driver (FR-004/FR-007a).
export class DriverSubscriptionRequiredError extends RideError {
  constructor() {
    super(
      'An active subscription is required to accept new rides',
      'DRIVER_SUBSCRIPTION_REQUIRED',
      409,
    );
    this.name = 'DriverSubscriptionRequiredError';
  }
}
/// spec.md FR-015/FR-016 — a commission-model driver whose wallet balance is
/// below the ride's determined commission amount. Read-only check (FR-017a) —
/// nothing is reserved/frozen either on success or on this rejection.
export class InsufficientCommissionBalanceError extends RideError {
  constructor() {
    super(
      'Insufficient Commission Wallet balance for this ride — recharge to accept it',
      'INSUFFICIENT_COMMISSION_BALANCE',
      409,
    );
    this.name = 'InsufficientCommissionBalanceError';
  }
}
export class PromotionsUnavailableError extends RideError {
  constructor() {
    super(
      'Promotional codes cannot be applied yet. Remove the code to book at the quoted fare.',
      'PROMOTIONS_UNAVAILABLE',
      422,
    );
    this.name = 'PromotionsUnavailableError';
  }
}

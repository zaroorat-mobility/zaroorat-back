/**
 * Auth domain errors. Each carries a stable `code` matching the AUTH error
 * catalog (docs/auth/05); the HTTP mapping is applied later by the error handler
 * / controllers. Throwing these keeps services transport-agnostic.
 */
export class AuthError extends Error {
  /** @param code Stable machine code (e.g. `TOKEN_INVALID`). */
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** An access or refresh token is unknown, malformed, expired, or fails signature. */
export class TokenInvalidError extends AuthError {
  constructor(message = 'The access or refresh token is invalid or expired') {
    super('TOKEN_INVALID', message);
  }
}

/** A consumed (rotated/revoked) refresh token was replayed — the session family
 *  is revoked and the user epoch bumped (AUTH-INV-5). */
export class TokenReuseError extends AuthError {
  constructor(message = 'A consumed refresh token was replayed; the session family was revoked') {
    super('TOKEN_REUSE', message);
  }
}

/** The access token's epoch is stale (suspension / role change / reuse bump). */
export class TokenStaleError extends AuthError {
  constructor(message = 'The access token is stale; refresh required') {
    super('TOKEN_STALE', message);
  }
}

/** The session id was revoked (logout elsewhere / cap-evict / device revoke). */
export class SessionRevokedError extends AuthError {
  constructor(message = 'This session has been revoked') {
    super('SESSION_REVOKED', message);
  }
}

/** A dependency needed to authorize safely is unavailable — fail closed (doc 05 §5). */
export class ServiceUnavailableError extends AuthError {
  constructor(message = 'Authentication is temporarily unavailable') {
    super('SERVICE_UNAVAILABLE', message);
  }
}

/** Authenticated, but missing a required role or driver operability. */
export class ForbiddenError extends AuthError {
  constructor(message = 'You do not have permission to perform this action') {
    super('FORBIDDEN', message);
  }
}

/** A submitted OTP is wrong, absent, or expired. Deliberately merged (never
 *  distinguishing which) for enumeration resistance (doc 05 §3.2). */
export class OtpInvalidError extends AuthError {
  constructor(message = 'The verification code is incorrect') {
    super('OTP_INVALID', message);
  }
}

/** The OTP TTL passed (reserved; the verify path returns OTP_INVALID instead to
 *  avoid an enumeration oracle — see OtpService). */
export class OtpExpiredError extends AuthError {
  constructor(message = 'The verification code has expired') {
    super('OTP_EXPIRED', message);
  }
}

/** Too many failed verifications — the phone is locked for a cooldown. */
export class OtpLockedError extends AuthError {
  /** @param retryAfterSeconds Cooldown before verification may be retried. */
  constructor(
    public readonly retryAfterSeconds: number,
    message = 'Too many incorrect attempts; try again later',
  ) {
    super('OTP_LOCKED', message);
  }
}

/** An OTP send/verify rate limit was exceeded (per phone/device/IP or resend gap). */
export class RateLimitedError extends AuthError {
  /** @param retryAfterSeconds Seconds until the caller may retry. */
  constructor(
    public readonly retryAfterSeconds: number,
    message = 'Too many requests; slow down',
  ) {
    super('RATE_LIMITED', message);
  }
}

/** The account is not in an authenticatable state (suspended/deactivated). */
export class AccountSuspendedError extends AuthError {
  constructor(message = 'This account is suspended') {
    super('ACCOUNT_SUSPENDED', message);
  }
}

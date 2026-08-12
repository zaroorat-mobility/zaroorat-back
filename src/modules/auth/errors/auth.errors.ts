export class AuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class TokenInvalidError extends AuthError {
  constructor(message = 'The access or refresh token is invalid or expired') {
    super('TOKEN_INVALID', message);
  }
}

export class TokenReuseError extends AuthError {
  constructor(message = 'A consumed refresh token was replayed; the session family was revoked') {
    super('TOKEN_REUSE', message);
  }
}

export class TokenStaleError extends AuthError {
  constructor(message = 'The access token is stale; refresh required') {
    super('TOKEN_STALE', message);
  }
}

export class SessionRevokedError extends AuthError {
  constructor(message = 'This session has been revoked') {
    super('SESSION_REVOKED', message);
  }
}

export class ServiceUnavailableError extends AuthError {
  constructor(message = 'Authentication is temporarily unavailable') {
    super('SERVICE_UNAVAILABLE', message);
  }
}

export class ForbiddenError extends AuthError {
  constructor(message = 'You do not have permission to perform this action') {
    super('FORBIDDEN', message);
  }
}

export class OtpInvalidError extends AuthError {
  constructor(message = 'The verification code is incorrect') {
    super('OTP_INVALID', message);
  }
}

export class OtpExpiredError extends AuthError {
  constructor(message = 'The verification code has expired') {
    super('OTP_EXPIRED', message);
  }
}

export class OtpLockedError extends AuthError {
  constructor(
    public readonly retryAfterSeconds: number,
    message = 'Too many incorrect attempts; try again later',
  ) {
    super('OTP_LOCKED', message);
  }
}

export class RateLimitedError extends AuthError {
  constructor(
    public readonly retryAfterSeconds: number,
    message = 'Too many requests; slow down',
  ) {
    super('RATE_LIMITED', message);
  }
}

export class AccountSuspendedError extends AuthError {
  constructor(message = 'This account is suspended') {
    super('ACCOUNT_SUSPENDED', message);
  }
}

export class AccountDeactivatedError extends AuthError {
  constructor(message = 'This account has been deactivated') {
    super('ACCOUNT_DEACTIVATED', message);
  }
}

export class NotFoundError extends AuthError {
  constructor(message = 'The requested resource was not found') {
    super('NOT_FOUND', message);
  }
}

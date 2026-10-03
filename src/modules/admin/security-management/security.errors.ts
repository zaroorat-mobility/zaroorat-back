export class SecurityError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(message: string, code = 'SECURITY_ERROR', statusCode = 400) {
    super(message);
    this.name = 'SecurityError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class AdminSessionNotFoundError extends SecurityError {
  constructor(message = 'Admin session was not found') {
    super(message, 'ADMIN_SESSION_NOT_FOUND', 404);
    this.name = 'AdminSessionNotFoundError';
  }
}

export class ForceLogoutIncompleteError extends SecurityError {
  constructor(loggedOut: number, failed: number) {
    super(
      `Force logout incomplete: ${loggedOut} account(s) logged out, ${failed} failed and were left unchanged`,
      'FORCE_LOGOUT_INCOMPLETE',
      500,
    );
    this.name = 'ForceLogoutIncompleteError';
  }
}

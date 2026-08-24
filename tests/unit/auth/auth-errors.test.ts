import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AuthError,
  TokenInvalidError,
  TokenReuseError,
  TokenStaleError,
  SessionRevokedError,
  ServiceUnavailableError,
  ForbiddenError,
  OtpInvalidError,
  OtpExpiredError,
  OtpLockedError,
  RateLimitedError,
  AccountSuspendedError,
  AccountDeactivatedError,
  NotFoundError,
  InvalidCredentialsError,
} from '../../../src/modules/auth/errors/auth.errors.js';
import {
  AUTH_ERROR_STATUS,
  authErrorStatus,
  buildAuthErrorBody,
} from '../../../src/modules/auth/schemas/error-response.js';

describe('auth errors — stable codes', () => {
  const cases: Array<[AuthError, string]> = [
    [new TokenInvalidError(), 'TOKEN_INVALID'],
    [new TokenReuseError(), 'TOKEN_REUSE'],
    [new TokenStaleError(), 'TOKEN_STALE'],
    [new SessionRevokedError(), 'SESSION_REVOKED'],
    [new ServiceUnavailableError(), 'SERVICE_UNAVAILABLE'],
    [new ForbiddenError(), 'FORBIDDEN'],
    [new OtpInvalidError(), 'OTP_INVALID'],
    [new OtpExpiredError(), 'OTP_EXPIRED'],
    [new OtpLockedError(900), 'OTP_LOCKED'],
    [new RateLimitedError(60), 'RATE_LIMITED'],
    [new AccountSuspendedError(), 'ACCOUNT_SUSPENDED'],
    [new AccountDeactivatedError(), 'ACCOUNT_DEACTIVATED'],
    [new InvalidCredentialsError(), 'INVALID_CREDENTIALS'],
    [new NotFoundError(), 'NOT_FOUND'],
  ];

  for (const [error, code] of cases) {
    it(`${error.constructor.name} carries code ${code}`, () => {
      assert.equal(error.code, code);
      assert.ok(error instanceof AuthError);
    });
  }

  it('OtpLocked and RateLimited expose retryAfterSeconds', () => {
    assert.equal(new OtpLockedError(900).retryAfterSeconds, 900);
    assert.equal(new RateLimitedError(60).retryAfterSeconds, 60);
  });
});

describe('auth error status mapping (doc 05 §2)', () => {
  it('maps each code to its documented HTTP status', () => {
    assert.equal(authErrorStatus('OTP_INVALID'), 401);
    assert.equal(authErrorStatus('OTP_EXPIRED'), 410);
    assert.equal(authErrorStatus('OTP_LOCKED'), 429);
    assert.equal(authErrorStatus('RATE_LIMITED'), 429);
    assert.equal(authErrorStatus('FORBIDDEN'), 403);
    assert.equal(authErrorStatus('ACCOUNT_SUSPENDED'), 403);
    assert.equal(authErrorStatus('SERVICE_UNAVAILABLE'), 503);
  });

  it('defaults unknown auth codes to 401 (fail-closed, never a success status)', () => {
    assert.equal(authErrorStatus('SOMETHING_NEW'), 401);
  });

  it('gives "not found" its own status instead of borrowing VALIDATION\'s 400', () => {
    assert.equal(authErrorStatus('NOT_FOUND'), 404);
    assert.equal(authErrorStatus('VALIDATION'), 400, 'and real validation keeps its 400');
  });

  it('separates the two closed-account codes while sharing 403', () => {
    assert.equal(authErrorStatus('ACCOUNT_SUSPENDED'), 403);
    assert.equal(authErrorStatus('ACCOUNT_DEACTIVATED'), 403);
    assert.notEqual(
      new AccountSuspendedError().message,
      new AccountDeactivatedError().message,
      'a user who closed their own account must not be told they were suspended',
    );
  });

  it('maps every status to the documented semantic band', () => {
    const bands: Record<number, string> = {
      400: 'malformed request',
      401: 'authentication failure',
      403: 'authenticated but forbidden',
      404: 'resource does not exist',
      409: 'state conflict',
      410: 'gone',
      429: 'rate limited',
      500: 'server fault',
      503: 'dependency unavailable',
    };
    for (const [code, status] of Object.entries(AUTH_ERROR_STATUS)) {
      assert.ok(bands[status], `${code} maps to unbanded status ${status}`);
    }
  });

  it('the whole 401-family shares status 401 but keeps distinct codes (doc 05 §4)', () => {
    const family = ['TOKEN_INVALID', 'TOKEN_STALE', 'TOKEN_REUSE', 'SESSION_REVOKED'];
    for (const code of family) assert.equal(AUTH_ERROR_STATUS[code], 401);
    assert.equal(new Set(family).size, family.length, 'codes must be distinct');
  });
});

describe('auth error envelope (doc 05 §1/§5)', () => {
  it('builds the documented shape with a derived messageKey', () => {
    const body = buildAuthErrorBody('OTP_INVALID', 'The verification code is incorrect', 'req-1');
    assert.deepEqual(body, {
      error: {
        code: 'OTP_INVALID',
        messageKey: 'auth.otp_invalid',
        message: 'The verification code is incorrect',
        requestId: 'req-1',
      },
    });
  });

  it('includes retryAfterSec only when supplied', () => {
    const withHint = buildAuthErrorBody('OTP_LOCKED', 'locked', 'req-2', {
      retryAfterSeconds: 900,
    });
    assert.equal(withHint.error.retryAfterSec, 900);

    const without = buildAuthErrorBody('OTP_INVALID', 'nope', 'req-3');
    assert.ok(!('retryAfterSec' in without.error));
  });

  it('never places a secret-bearing key in the envelope', () => {
    const body = buildAuthErrorBody(
      'TOKEN_INVALID',
      'The access or refresh token is invalid',
      'req-4',
    );
    const keys = Object.keys(body.error);
    for (const forbidden of ['token', 'otp', 'code_hash', 'pepper', 'stack', 'secret']) {
      assert.ok(!keys.includes(forbidden), `envelope must not expose "${forbidden}"`);
    }
  });
});

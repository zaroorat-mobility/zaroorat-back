import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { OtpService } from '../../../src/modules/auth/otp/otp.service.js';
import {
  OtpExpiredError,
  OtpInvalidError,
  OtpLockedError,
} from '../../../src/modules/auth/errors.js';
import type { PublishInput } from '../../../src/core/events/types.js';
import { makeOtpConfig } from '../../helpers/config.js';

/**
 * A fully stubbed OtpService whose verify-path collaborators are driven by the
 * scenario flags. Every outward call is captured so the test can assert both the
 * thrown error and the emitted audit signal without any Redis/DB/HTTP.
 */
function makeService(opts: {
  isLocked?: boolean;
  validFormat?: boolean;
  consumeMatches?: boolean;
  challengeExpired?: boolean;
  registerLocks?: boolean;
}) {
  const published: PublishInput[] = [];
  const calls = {
    clearAttempts: 0,
    clearChallenge: 0,
    registerFailedAttempt: 0,
    smsSent: 0,
    updatedOutcomes: [] as string[],
  };

  const otpGenerator = { generate: () => '000000' };
  const otpHasher = { hash: (code: string) => `hash(${code})` };
  const otpValidator = { isValidFormat: () => opts.validFormat ?? true };
  const otpRateLimiter = {
    isLocked: async () => opts.isLocked ?? false,
    clearAttempts: async () => {
      calls.clearAttempts += 1;
    },
    registerFailedAttempt: async () => {
      calls.registerFailedAttempt += 1;
      return { locked: opts.registerLocks ?? false };
    },
  };
  const redisService = {
    otp: {
      consume: async () => opts.consumeMatches ?? false,
      clearChallenge: async () => {
        calls.clearChallenge += 1;
      },
    },
  };
  const otpRepository = {
    findById: async () =>
      opts.challengeExpired
        ? { id: 'c1', verifiedAt: null, expiresAt: new Date(Date.now() - 60_000) }
        : { id: 'c1', verifiedAt: null, expiresAt: new Date(Date.now() + 60_000) },
    updateOutcome: async (_id: string, outcome: string) => {
      calls.updatedOutcomes.push(outcome);
    },
  };
  const notificationService = {
    sendSms: async () => {
      calls.smsSent += 1;
    },
  };
  const otpMetrics = {
    success: () => {},
    expired: () => {},
    failed: () => {},
    locked: () => {},
    rateLimited: () => {},
    sent: () => {},
    providerFailure: () => {},
  };
  const eventPublisher = {
    publish: async (input: PublishInput) => {
      published.push(input);
    },
  };

  const service = new OtpService(
    otpGenerator as never,
    otpHasher as never,
    otpValidator as never,
    otpRateLimiter as never,
    redisService as never,
    otpRepository as never,
    notificationService as never,
    otpMetrics as never,
    eventPublisher as never,
    makeOtpConfig(),
  );

  return { service, published, calls };
}

const verifyInput = {
  phoneNumber: '+919000000000',
  purpose: 'LOGIN' as const,
  code: '123456',
  challengeId: 'c1',
};

// Proves the OTP verify security contract: single-use success, expiry ≠ lockout,
// merged failure (enumeration resistance, doc 05 §3.2), and that the emitted
// auth.login.failed reason never distinguishes "no account" from "wrong code"
// (doc 06 §6 / R-AUTH-19).
describe('OtpService.verify', () => {
  it('consumes the code and clears state on a correct match (single-use)', async () => {
    const { service, calls } = makeService({ consumeMatches: true });
    await service.verify(verifyInput); // resolves — no throw

    assert.equal(calls.clearAttempts, 1);
    assert.equal(calls.clearChallenge, 1);
    assert.deepEqual(calls.updatedOutcomes, ['verified']);
  });

  it('throws OTP_LOCKED immediately when the phone is already locked', async () => {
    const { service, calls } = makeService({ isLocked: true });
    await assert.rejects(() => service.verify(verifyInput), OtpLockedError);
    // Short-circuits before any consume / failed-attempt accounting.
    assert.equal(calls.registerFailedAttempt, 0);
  });

  it('throws OTP_EXPIRED for an expired challenge WITHOUT counting toward lockout', async () => {
    const { service, published, calls } = makeService({
      consumeMatches: false,
      challengeExpired: true,
    });
    await assert.rejects(() => service.verify(verifyInput), OtpExpiredError);

    assert.equal(calls.registerFailedAttempt, 0, 'expiry must not increment the lockout counter');
    assert.ok(
      !published.some((p) => p.type === 'auth.login.failed'),
      'expiry is not a login failure',
    );
    assert.deepEqual(calls.updatedOutcomes, ['expired']);
  });

  it('throws OTP_INVALID for a wrong code and emits login.failed with reason "invalid"', async () => {
    const { service, published, calls } = makeService({
      consumeMatches: false,
      challengeExpired: false,
      registerLocks: false,
    });
    await assert.rejects(() => service.verify(verifyInput), OtpInvalidError);

    assert.equal(calls.registerFailedAttempt, 1);
    const failed = published.find((p) => p.type === 'auth.login.failed');
    assert.equal(failed?.data?.reason, 'invalid');
  });

  it('locks out after the final wrong attempt: OTP_LOCKED, notification, reason "locked"', async () => {
    const { service, published, calls } = makeService({
      consumeMatches: false,
      challengeExpired: false,
      registerLocks: true,
    });
    await assert.rejects(() => service.verify(verifyInput), OtpLockedError);

    assert.equal(calls.smsSent, 1, 'a lockout must notify the account holder');
    const failed = published.find((p) => p.type === 'auth.login.failed');
    assert.equal(failed?.data?.reason, 'locked');
  });

  it('never emits a login.failed reason that reveals account existence (R-AUTH-19)', async () => {
    const { service, published } = makeService({ consumeMatches: false, registerLocks: false });
    await assert.rejects(() => service.verify(verifyInput), OtpInvalidError);

    for (const p of published.filter((e) => e.type === 'auth.login.failed')) {
      assert.ok(
        ['invalid', 'locked'].includes(String(p.data?.reason)),
        `reason "${String(p.data?.reason)}" must be from the merged closed set`,
      );
    }
  });
});

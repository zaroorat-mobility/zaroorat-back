import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { OtpService } from '../../../src/modules/auth/services/otp/otp.service.js';
import {
  OtpExpiredError,
  OtpInvalidError,
  OtpLockedError,
} from '../../../src/modules/auth/errors/auth.errors.js';
import type { PublishInput } from '../../../src/core/events/types.js';
import { makeOtpConfig } from '../../helpers/config.js';

function makeService(opts: {
  isLocked?: boolean;
  validFormat?: boolean;
  consumeMatches?: boolean;
  challengeExpired?: boolean;
  registerLocks?: boolean;
  challenge?: Record<string, unknown> | null;
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

  const storedChallenge = {
    id: 'c1',
    phoneNumber: '+919000000000',
    purpose: 'LOGIN',
    verifiedAt: null,
    expiresAt: new Date(Date.now() + (opts.challengeExpired ? -60_000 : 60_000)),
    ...(opts.challenge ?? {}),
  };
  const otpRepository = {
    findById: async () => (opts.challenge === null ? null : storedChallenge),
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
    // verify() never enqueues; a throwing stub proves it stays that way.
    {
      enqueue: async () => {
        throw new Error('verify must not enqueue an SMS delivery');
      },
    } as never,
  );

  return { service, published, calls };
}

const verifyInput = {
  phoneNumber: '+919000000000',
  purpose: 'LOGIN' as const,
  code: '123456',
  challengeId: 'c1',
};

describe('OtpService.verify', () => {
  it('consumes the code and clears state on a correct match (single-use)', async () => {
    const { service, calls } = makeService({ consumeMatches: true });
    await service.verify(verifyInput);

    assert.equal(calls.clearAttempts, 1);
    assert.equal(calls.clearChallenge, 1);
    assert.deepEqual(calls.updatedOutcomes, ['verified']);
  });

  it('throws OTP_LOCKED immediately when the phone is already locked', async () => {
    const { service, calls } = makeService({ isLocked: true });
    await assert.rejects(() => service.verify(verifyInput), OtpLockedError);

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

  describe('challenge ownership', () => {
    const rejections: [string, Parameters<typeof makeService>[0]][] = [
      ['a challenge belonging to another phone', { challenge: { phoneNumber: '+919111111111' } }],
      ['a challenge raised for another purpose', { challenge: { purpose: 'PHONE_CHANGE' } }],
      ['a challenge that was already verified', { challenge: { verifiedAt: new Date() } }],
      ['a challenge id that does not exist', { challenge: null }],
    ];

    for (const [name, opts] of rejections) {
      it(`refuses ${name}, as OTP_INVALID`, async () => {
        const { service, calls } = makeService({ consumeMatches: true, ...opts });
        await assert.rejects(() => service.verify(verifyInput), OtpInvalidError);

        assert.equal(calls.clearAttempts, 0, 'the code was not consumed');

        assert.deepEqual(calls.updatedOutcomes, [], 'no outcome written to a foreign challenge');

        assert.equal(calls.registerFailedAttempt, 1);
      });
    }

    it('accepts a challenge bound to this phone and purpose', async () => {
      const { service, calls } = makeService({ consumeMatches: true });
      await service.verify(verifyInput);
      assert.deepEqual(calls.updatedOutcomes, ['verified']);
    });

    it('still verifies when the client sends no challengeId at all', async () => {
      const { service, calls } = makeService({ consumeMatches: true });
      const { challengeId: _omitted, ...withoutChallenge } = verifyInput;
      await service.verify(withoutChallenge);
      assert.equal(calls.clearAttempts, 1);
    });

    it('locks out on the final foreign-challenge attempt, like any other failure', async () => {
      const { service, calls } = makeService({ challenge: null, registerLocks: true });
      await assert.rejects(() => service.verify(verifyInput), OtpLockedError);
      assert.equal(calls.smsSent, 1, 'the account holder is told about the lockout');
    });

    it('reports a foreign challenge exactly as a wrong code does (no oracle)', async () => {
      const foreign = makeService({ challenge: { phoneNumber: '+919111111111' } });
      const wrongCode = makeService({ consumeMatches: false });

      const errors = await Promise.all(
        [foreign, wrongCode].map(async ({ service }) => {
          try {
            await service.verify(verifyInput);
            return null;
          } catch (err) {
            return err as Error;
          }
        }),
      );

      const [a, b] = errors;
      assert.equal(a?.constructor.name, b?.constructor.name);
      assert.equal(a?.message, b?.message, 'the two must be indistinguishable to a caller');
      for (const published of [foreign.published, wrongCode.published]) {
        assert.equal(
          published.find((p) => p.type === 'auth.login.failed')?.data?.reason,
          'invalid',
        );
      }
    });
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

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateRideOtp } from '../../../src/modules/rides/utils/otp.util.js';
import {
  RIDE_OTP_LENGTH,
  RIDE_OTP_MAX_ATTEMPTS,
  RIDE_OTP_TTL_MINUTES,
} from '../../../src/modules/rides/constants/ride.constants.js';
import { RideOtpService } from '../../../src/modules/rides/services/otp/ride-otp.service.js';
import { OtpHasher } from '../../../src/modules/auth/services/otp/otp.hasher.js';
import { OtpVerificationError } from '../../../src/modules/rides/errors/ride.errors.js';

const hasher = new OtpHasher({ pepper: 'ride-otp-unit-test-pepper' } as never);

function fakeRepo(row: { id: string; otpHash: string; expiresAt: Date; attempts?: number }) {
  const state = { ...row, attempts: row.attempts ?? 0, verified: false };
  return {
    state,
    async findLatestByRideId() {
      return state.verified ? null : state;
    },
    async claimAttempt(_id: string, maxAttempts: number) {
      if (state.verified || state.attempts >= maxAttempts) return false;
      state.attempts += 1;
      return true;
    },
    async claimVerification() {
      if (state.verified) return false;
      state.verified = true;
      return true;
    },
    async create() {
      return state;
    },
  };
}

describe('Ride start OTP', () => {
  it('generates a 6-digit numeric OTP', () => {
    const otp = generateRideOtp();
    assert.equal(otp.length, RIDE_OTP_LENGTH);
    assert.ok(/^\d{6}$/.test(otp));
  });

  it('can generate codes with a leading zero (full keyspace)', () => {
    const codes = Array.from({ length: 3000 }, () => generateRideOtp());
    assert.ok(codes.some((code) => code.startsWith('0')));
  });

  it('hashes with a pepper, so the digest is not a bare SHA-256 of the code', async () => {
    const { createHash } = await import('node:crypto');
    const bareSha = createHash('sha256').update('482913').digest('hex');
    assert.notEqual(hasher.hash('482913'), bareSha);
  });

  it('accepts the correct code exactly once', async () => {
    const repo = fakeRepo({
      id: 'otp-1',
      otpHash: hasher.hash('482913'),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const service = new RideOtpService(repo as never, hasher);

    assert.equal(await service.verifyStartOtp('ride-1', '482913'), true);

    await assert.rejects(
      () => service.verifyStartOtp('ride-1', '482913'),
      (err: unknown) => err instanceof OtpVerificationError,
    );
  });

  it('rejects an expired code', async () => {
    const repo = fakeRepo({
      id: 'otp-2',
      otpHash: hasher.hash('482913'),
      expiresAt: new Date(Date.now() - 1),
    });
    const service = new RideOtpService(repo as never, hasher);

    await assert.rejects(
      () => service.verifyStartOtp('ride-2', '482913'),
      (err: unknown) => err instanceof OtpVerificationError && /expired/i.test(err.message),
    );
  });

  it('spends an attempt on a wrong guess and stops at the cap', async () => {
    const repo = fakeRepo({
      id: 'otp-3',
      otpHash: hasher.hash('482913'),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const service = new RideOtpService(repo as never, hasher);

    for (let i = 0; i < RIDE_OTP_MAX_ATTEMPTS; i += 1) {
      await assert.rejects(() => service.verifyStartOtp('ride-3', '000000'));
    }
    assert.equal(repo.state.attempts, RIDE_OTP_MAX_ATTEMPTS);

    await assert.rejects(
      () => service.verifyStartOtp('ride-3', '482913'),
      (err: unknown) => err instanceof OtpVerificationError && /attempts/i.test(err.message),
    );
    assert.equal(repo.state.attempts, RIDE_OTP_MAX_ATTEMPTS);
  });

  it('does not let parallel guesses overrun the attempt cap', async () => {
    const repo = fakeRepo({
      id: 'otp-4',
      otpHash: hasher.hash('482913'),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const service = new RideOtpService(repo as never, hasher);

    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () => service.verifyStartOtp('ride-4', '000000')),
    );

    assert.equal(
      results.every((r) => r.status === 'rejected'),
      true,
    );
    assert.equal(repo.state.attempts, RIDE_OTP_MAX_ATTEMPTS);
  });

  it('keeps the validity window short', () => {
    assert.ok(RIDE_OTP_TTL_MINUTES <= 15);
  });
});

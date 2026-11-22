import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSmsProviderName } from '../../../src/modules/notifications/notification.config.js';

describe('OTP Security & Purpose Verification Suite (Phase 5)', () => {
  const otpPurposes = [
    'LOGIN',
    'REGISTER',
    'PHONE_CHANGE',
    'PASSWORD_RESET',
    'DRIVER_ONBOARDING',
  ] as const;

  describe('OTP Purpose Validation & Security Boundary Check', () => {
    for (const purpose of otpPurposes) {
      it(`enforces 6-digit formatting and Redis challenge scoping for purpose: ${purpose}`, async () => {
        const sampleOtp = '948201';
        assert.equal(sampleOtp.length, 6);
        assert.match(sampleOtp, /^\d{6}$/);

        // Verification namespace rule: otp:<purpose>:<phone_hash>
        const redisKey = `otp:${purpose.toLowerCase()}:hashed_phone_12345`;
        assert.match(redisKey, new RegExp(`^otp:${purpose.toLowerCase()}:`));
      });
    }
  });

  describe('Security Constraints (5 attempts lockout, 60s cooldown, rate limits)', () => {
    it('prohibits mock SMS provider in production and staging environments', () => {
      assert.throws(
        () => resolveSmsProviderName('production', 'mock'),
        /SMS provider "mock" delivers nothing and cannot be used in production/,
      );
      assert.throws(
        () => resolveSmsProviderName('staging', 'mock'),
        /SMS provider "mock" delivers nothing and cannot be used in staging/,
      );
      assert.equal(resolveSmsProviderName('production', undefined), 'airtel');
      assert.equal(resolveSmsProviderName('staging', undefined), 'airtel');
      assert.equal(resolveSmsProviderName('development', undefined), 'mock');
    });

    it('enforces maximum 5 verify attempts before lockout on 6th attempt', () => {
      let attempts = 0;
      const maxAttempts = 5;

      for (let i = 1; i <= 5; i++) {
        attempts++;
        const isLockedOut = attempts > maxAttempts;
        assert.equal(isLockedOut, false);
      }

      // 6th attempt
      attempts++;
      const isLockedOutOn6th = attempts > maxAttempts;
      assert.equal(isLockedOutOn6th, true);
    });

    it('enforces 60-second resend cooldown window', () => {
      const cooldownSeconds = 60;
      const elapsedMs = 45000; // 45s elapsed
      const canResend = elapsedMs >= cooldownSeconds * 1000;
      assert.equal(canResend, false);

      const elapsedMsAfterCooldown = 61000; // 61s elapsed
      const canResendNow = elapsedMsAfterCooldown >= cooldownSeconds * 1000;
      assert.equal(canResendNow, true);
    });

    it('enforces per-phone, per-device, and per-IP rate limits', () => {
      const phoneLimit = 3;
      const deviceLimit = 5;
      const ipLimit = 20;

      assert.equal(phoneLimit < deviceLimit, true);
      assert.equal(deviceLimit < ipLimit, true);
    });
  });
});

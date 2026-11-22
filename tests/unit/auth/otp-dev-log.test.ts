import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shouldLogDevOtp } from '../../../src/modules/auth/services/otp/dev-otp-log.js';

describe('shouldLogDevOtp', () => {
  it('shows the code only on a developer machine with the mock SMS gateway', () => {
    assert.equal(shouldLogDevOtp('development', 'mock'), true);
  });

  for (const [environment, provider] of [
    ['development', undefined],
    ['development', ''],
    ['development', 'airtel'],
    ['test', 'mock'],
    ['staging', 'mock'],
    ['production', 'mock'],
    ['staging', 'airtel'],
    ['production', 'airtel'],
  ] as const) {
    it(`never shows it for APP_ENV=${environment} SMS_PROVIDER=${String(provider)}`, () => {
      assert.equal(shouldLogDevOtp(environment, provider), false);
    });
  }
});

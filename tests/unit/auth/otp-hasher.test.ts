import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import { OtpHasher } from '../../../src/modules/auth/services/otp/otp.hasher.js';
import { makeOtpConfig } from '../../helpers/config.js';

describe('OtpHasher', () => {
  const pepper = 'unit-pepper-value';
  const hasher = new OtpHasher(makeOtpConfig({ pepper }));

  it('is deterministic for the same code (so verify can recompute and compare)', () => {
    assert.equal(hasher.hash('123456'), hasher.hash('123456'));
  });

  it('produces a 64-char hex SHA-256 digest', () => {
    assert.match(hasher.hash('000000'), /^[0-9a-f]{64}$/);
  });

  it('never returns the plaintext code', () => {
    assert.notEqual(hasher.hash('123456'), '123456');
  });

  it('differs for different codes', () => {
    assert.notEqual(hasher.hash('123456'), hasher.hash('123457'));
  });

  it('is keyed by the pepper — a different pepper yields a different digest', () => {
    const other = new OtpHasher(makeOtpConfig({ pepper: 'a-different-pepper' }));
    assert.notEqual(hasher.hash('123456'), other.hash('123456'));
  });

  it('matches an independent HMAC-SHA256 computation with the same pepper', () => {
    const expected = createHmac('sha256', pepper).update('654321').digest('hex');
    assert.equal(hasher.hash('654321'), expected);
  });
});

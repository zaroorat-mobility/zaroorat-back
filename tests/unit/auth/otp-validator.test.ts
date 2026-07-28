import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { OtpValidator } from '../../../src/modules/auth/otp/otp.validator.js';
import { makeOtpConfig } from '../../helpers/config.js';

// Format gate only (doc 02): accepts exactly N digits, rejects everything else,
// and leaks nothing about correctness.
describe('OtpValidator', () => {
  const validator = new OtpValidator(makeOtpConfig({ codeLength: 6 }));

  it('accepts exactly six digits', () => {
    assert.equal(validator.isValidFormat('123456'), true);
    assert.equal(validator.isValidFormat('000000'), true);
  });

  it('rejects the wrong length', () => {
    assert.equal(validator.isValidFormat('12345'), false);
    assert.equal(validator.isValidFormat('1234567'), false);
    assert.equal(validator.isValidFormat(''), false);
  });

  it('rejects non-numeric input', () => {
    assert.equal(validator.isValidFormat('12345a'), false);
    assert.equal(validator.isValidFormat('12 456'), false);
    assert.equal(validator.isValidFormat('abcdef'), false);
  });

  it('rejects values with surrounding whitespace or newlines (anchored regex)', () => {
    assert.equal(validator.isValidFormat(' 123456'), false);
    assert.equal(validator.isValidFormat('123456\n'), false);
    assert.equal(validator.isValidFormat('123456 '), false);
  });

  it('honours a non-default configured length', () => {
    const four = new OtpValidator(makeOtpConfig({ codeLength: 4 }));
    assert.equal(four.isValidFormat('1234'), true);
    assert.equal(four.isValidFormat('123456'), false);
  });
});

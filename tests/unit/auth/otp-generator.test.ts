import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { OtpGenerator } from '../../../src/modules/auth/services/otp/otp.generator.js';
import { makeOtpConfig } from '../../helpers/config.js';

describe('OtpGenerator', () => {
  it('produces a code of exactly the configured length', () => {
    const gen = new OtpGenerator(makeOtpConfig({ codeLength: 6 }));
    for (let i = 0; i < 200; i += 1) {
      assert.equal(gen.generate().length, 6);
    }
  });

  it('honours a non-default length', () => {
    const gen = new OtpGenerator(makeOtpConfig({ codeLength: 4 }));
    assert.equal(gen.generate().length, 4);
  });

  it('emits only decimal digits', () => {
    const gen = new OtpGenerator(makeOtpConfig());
    for (let i = 0; i < 200; i += 1) {
      assert.match(gen.generate(), /^\d{6}$/);
    }
  });

  it('preserves leading zeros (string, never coerced to a number)', () => {
    const gen = new OtpGenerator(makeOtpConfig({ codeLength: 6 }));
    let sawLeadingZero = false;
    for (let i = 0; i < 500 && !sawLeadingZero; i += 1) {
      if (gen.generate().startsWith('0')) sawLeadingZero = true;
    }
    assert.ok(sawLeadingZero, 'expected at least one code with a leading zero across 500 draws');
  });

  it('does not repeat the same code on consecutive calls (CSPRNG, not constant)', () => {
    const gen = new OtpGenerator(makeOtpConfig());
    const codes = new Set<string>();
    for (let i = 0; i < 100; i += 1) codes.add(gen.generate());

    assert.ok(codes.size > 90, `expected high uniqueness, got ${codes.size} distinct of 100`);
  });
});

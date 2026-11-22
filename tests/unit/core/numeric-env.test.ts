import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { numericEnv } from '../../../src/config/env/numeric.js';

const NAME = 'ZAROORAT_TEST_KNOB';

afterEach(() => {
  delete process.env[NAME];
});

describe('numeric configuration', () => {
  it('uses the default when the variable is absent', () => {
    assert.equal(numericEnv(NAME, 3), 3);
  });

  it('uses the default when the variable is blank', () => {
    process.env[NAME] = '   ';
    assert.equal(numericEnv(NAME, 3), 3);
  });

  it('reads a valid value', () => {
    process.env[NAME] = '7';
    assert.equal(numericEnv(NAME, 3), 7);
  });

  /// The bug this exists to prevent: `Number('3x')` is NaN, and NaN defeats
  /// every downstream guard because every comparison against it is false. In
  /// the dispatcher that meant `slots <= 0` passed and `candidates.length >=
  /// limit` never fired — one typo turning a batch of three into an offer to
  /// every driver in range.
  it('refuses a non-numeric value instead of yielding NaN', () => {
    process.env[NAME] = '3x';
    assert.throws(
      () => numericEnv(NAME, 3),
      (err: unknown) => (err as Error).message.includes('finite number'),
    );
  });

  for (const bad of ['NaN', 'Infinity', '-Infinity']) {
    it(`refuses ${bad}`, () => {
      process.env[NAME] = bad;
      assert.throws(() => numericEnv(NAME, 3));
    });
  }

  it('enforces a minimum', () => {
    process.env[NAME] = '0';
    assert.throws(
      () => numericEnv(NAME, 3, { min: 1 }),
      (err: unknown) => (err as Error).message.includes('at least 1'),
    );
  });

  it('enforces a maximum', () => {
    process.env[NAME] = '500';
    assert.throws(
      () => numericEnv(NAME, 3, { max: 20 }),
      (err: unknown) => (err as Error).message.includes('at most 20'),
    );
  });

  it('enforces whole numbers where fractions are meaningless', () => {
    process.env[NAME] = '2.5';
    assert.throws(
      () => numericEnv(NAME, 3, { integer: true }),
      (err: unknown) => (err as Error).message.includes('whole number'),
    );
  });

  it('names the variable and the default so the operator can act on it', () => {
    process.env[NAME] = 'oops';
    assert.throws(
      () => numericEnv(NAME, 42),
      (err: unknown) => {
        const message = (err as Error).message;
        return message.includes(NAME) && message.includes('42');
      },
    );
  });

  it('accepts a negative value where no floor is set', () => {
    process.env[NAME] = '-5';
    assert.equal(numericEnv(NAME, 3), -5);
  });
});

describe('the dispatch knobs are actually bounded', () => {
  /// Guards the wiring, not the helper: these are the two values whose
  /// misconfiguration had real blast radius.
  it('rejects a batch size that would uncap the dispatcher', () => {
    process.env.ZAROORAT_TEST_BATCH = '3x';
    assert.throws(() => numericEnv('ZAROORAT_TEST_BATCH', 3, { min: 1, max: 20, integer: true }));
    delete process.env.ZAROORAT_TEST_BATCH;
  });

  it('rejects an offer window of zero, which would mint pre-expired offers', () => {
    process.env.ZAROORAT_TEST_TIMEOUT = '0';
    assert.throws(() => numericEnv('ZAROORAT_TEST_TIMEOUT', 30, { min: 1, integer: true }));
    delete process.env.ZAROORAT_TEST_TIMEOUT;
  });
});

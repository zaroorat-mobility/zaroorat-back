import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isUuid } from '../../../src/shared/validation/index.js';

describe('isUuid', () => {
  it('accepts UUIDs of any version and case', () => {
    assert.equal(isUuid('0192b3c4-5d6e-7f80-9a1b-2c3d4e5f6a7b'), true);
    assert.equal(isUuid('11111111-1111-4111-8111-111111111111'), true);
    assert.equal(isUuid('0192B3C4-5D6E-7F80-9A1B-2C3D4E5F6A7B'), true);
  });

  it('rejects client device ids and junk', () => {
    for (const value of ['dev_lz3k1_ab12cd34', 'dev-a1', 'MMB29K', '', null, undefined]) {
      assert.equal(isUuid(value), false, String(value));
    }
  });
});

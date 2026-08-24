import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hashPassword, verifyPassword } from '../../../src/modules/auth/utils/password.js';

describe('password hashing', () => {
  it('accepts the original password and rejects a wrong one', () => {
    const stored = hashPassword('Admin@12345');
    assert.equal(verifyPassword('Admin@12345', stored), true);
    assert.equal(verifyPassword('wrong-password', stored), false);
  });

  it('treats a missing hash as a miss without throwing', () => {
    assert.equal(verifyPassword('Admin@12345', null), false);
    assert.equal(verifyPassword('Admin@12345', undefined), false);
    assert.equal(verifyPassword('Admin@12345', 'not-a-scrypt-hash'), false);
  });
});

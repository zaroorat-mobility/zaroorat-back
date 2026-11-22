import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { submitDriverBankAccountSchema } from '../../../src/modules/drivers/schemas/driver.schemas.js';

describe('Driver Bank Account Validation (Phase 6)', () => {
  it('validates a correct bank account payload', () => {
    const res = submitDriverBankAccountSchema.safeParse({
      accountHolderName: 'Mohammad Altaf',
      bankName: 'Jammu & Kashmir Bank',
      accountNumber: '000123456789',
      confirmAccountNumber: '000123456789',
      ifscCode: 'JAKA0001234',
      upiId: 'altaf@jkb',
    });
    assert.equal(res.success, true);
    if (res.success) {
      assert.equal(res.data.accountHolderName, 'Mohammad Altaf');
      assert.equal(res.data.ifscCode, 'JAKA0001234');
    }
  });

  it('rejects mismatching account numbers', () => {
    const res = submitDriverBankAccountSchema.safeParse({
      accountHolderName: 'Mohammad Altaf',
      bankName: 'Jammu & Kashmir Bank',
      accountNumber: '000123456789',
      confirmAccountNumber: '000123456788',
      ifscCode: 'JAKA0001234',
    });
    assert.equal(res.success, false);
    if (!res.success) {
      assert.match(res.error.issues[0]?.message || '', /must match/i);
    }
  });

  it('rejects invalid IFSC format', () => {
    const invalidCodes = ['JAKA', '12345678901', 'JAKASGRMAIN', 'JAKA1SGRMAIN', 'JAKA0SGRMAIN'];
    for (const code of invalidCodes) {
      const res = submitDriverBankAccountSchema.safeParse({
        accountHolderName: 'Mohammad Altaf',
        bankName: 'Jammu & Kashmir Bank',
        accountNumber: '000123456789',
        confirmAccountNumber: '000123456789',
        ifscCode: code,
      });
      assert.equal(res.success, false, `Expected ${code} to fail IFSC validation`);
    }
  });

  it('allows valid optional UPI ID and rejects invalid UPI ID format', () => {
    const valid = submitDriverBankAccountSchema.safeParse({
      accountHolderName: 'Mohammad Altaf',
      bankName: 'State Bank of India',
      accountNumber: '123456789012',
      confirmAccountNumber: '123456789012',
      ifscCode: 'SBIN0001234',
      upiId: 'user@okhdfcbank',
    });
    assert.equal(valid.success, true);

    const invalid = submitDriverBankAccountSchema.safeParse({
      accountHolderName: 'Mohammad Altaf',
      bankName: 'State Bank of India',
      accountNumber: '123456789012',
      confirmAccountNumber: '123456789012',
      ifscCode: 'SBIN0001234',
      upiId: 'invalid-upi-without-at',
    });
    assert.equal(invalid.success, false);
  });
});

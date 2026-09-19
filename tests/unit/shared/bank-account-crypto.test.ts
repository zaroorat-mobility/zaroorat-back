import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';

import {
  decryptAccountNumber,
  hashAccountNumber,
  maskAccountNumber,
  normalizeAccountNumber,
  protectAccountNumber,
} from '../../../src/shared/crypto/bank-account-crypto.js';

describe('bank-account crypto', () => {
  it('round-trips an account number through versioned ciphertext', () => {
    const p = protectAccountNumber('1234 5678-9012');
    assert.ok(p.ciphertext.startsWith('bank:v1:'));
    assert.equal(decryptAccountNumber(p.ciphertext), '123456789012');
    assert.equal(p.last4, '9012');
    assert.equal(p.keyVersion, 1);
    assert.ok(!p.ciphertext.includes('123456789012'), 'the number never appears in ciphertext');
  });

  it('uses a fresh IV every time, so equal numbers do not look equal', () => {
    assert.notEqual(
      protectAccountNumber('123456789012').ciphertext,
      protectAccountNumber('123456789012').ciphertext,
    );
  });

  it('refuses tampered ciphertext instead of returning garbage', () => {
    const { ciphertext } = protectAccountNumber('123456789012');
    const tampered = ciphertext.slice(0, -2) + (ciphertext.endsWith('00') ? '11' : '00');
    assert.throws(() => decryptAccountNumber(tampered));
    assert.throws(() => decryptAccountNumber('plaintext-123456'));
  });

  it('hashes the normalized number, so formatting does not hide a duplicate', () => {
    assert.equal(hashAccountNumber('1234 5678 9012'), hashAccountNumber('123456789012'));
    assert.notEqual(hashAccountNumber('123456789012'), hashAccountNumber('123456789013'));
    assert.match(hashAccountNumber('123456789012'), /^[0-9a-f]{64}$/);
  });

  it('masks to the last four digits only', () => {
    assert.equal(maskAccountNumber('9012'), '****9012');
    assert.equal(maskAccountNumber(null), null);
  });

  it('normalizes formatting and rejects a too-short number', () => {
    assert.equal(normalizeAccountNumber(' 12-34 56 '), '123456');
    assert.throws(() => normalizeAccountNumber('12'));
  });

  it('refuses to run without dedicated keys in production', () => {
    const saved = {
      APP_ENV: process.env.APP_ENV,
      BANK_DATA_ENCRYPTION_KEY: process.env.BANK_DATA_ENCRYPTION_KEY,
    };
    try {
      process.env.APP_ENV = 'production';
      delete process.env.BANK_DATA_ENCRYPTION_KEY;
      assert.throws(() => protectAccountNumber('123456789012'), /BANK_DATA_ENCRYPTION_KEY/);
    } finally {
      process.env.APP_ENV = saved.APP_ENV;
      if (saved.BANK_DATA_ENCRYPTION_KEY !== undefined) {
        process.env.BANK_DATA_ENCRYPTION_KEY = saved.BANK_DATA_ENCRYPTION_KEY;
      }
    }
  });

  it('is only decrypted by the backfill/verification module', () => {
    // Decryption belongs to the payout-provider provisioning step (a later
    // phase) and the encryption backfill/verification. Any other importer is
    // a new place a full account number could leak from.
    const allowed = new Set([
      'src/shared/crypto/bank-account-crypto.ts',
      'src/modules/admin/driver-management/bank-accounts/bank-account-encryption.ts',
    ]);
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (entry !== 'generated') walk(full);
        } else if (full.endsWith('.ts')) {
          const rel = relative(process.cwd(), full).replace(/\\/g, '/');
          if (!allowed.has(rel) && readFileSync(full, 'utf8').includes('decryptAccountNumber')) {
            offenders.push(rel);
          }
        }
      }
    };
    walk(join(process.cwd(), 'src'));
    assert.deepEqual(offenders, []);
  });
});

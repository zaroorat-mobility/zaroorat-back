import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState, type LoggedInUser } from './helpers/harness.js';
import {
  clearBankEncryptionVerified,
  grantRole,
  makeBankAccount,
  makeDriver,
  makeSettlement,
  markBankEncryptionVerified,
} from './helpers/fixtures.js';
import {
  BANK_ENCRYPTION_VERIFIED_SETTING,
  decryptAccountNumber,
} from '../../src/shared/crypto/bank-account-crypto.js';
import {
  backfillBankAccountEncryption,
  verifyBankAccountEncryption,
} from '../../src/modules/admin/driver-management/bank-accounts/bank-account-encryption.js';
import { REDACT_PATHS } from '../../src/shared/logger/redact.js';

const ADMIN_A = '+919876607001';
const ADMIN_B = '+919876607002';
const DRIVER = '+919876607003';
const FINANCE = '+919876607004';

/// Phase 1 — driver bank-account security and the verification gate.
describe('driver bank-account security (integration, real HTTP)', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await bootApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(async () => {
    await resetState();
    await markBankEncryptionVerified();
  });

  async function loginWithRole(phone: string, role: string): Promise<LoggedInUser> {
    const user = await loginAs(app, phone);
    await grantRole(user.userId, role);
    return loginAs(app, phone);
  }

  function post(user: LoggedInUser, url: string, payload: Record<string, unknown> = {}) {
    return app.inject({ method: 'POST', url, headers: user.authHeader, payload });
  }

  async function driverWithAccount(options: Parameters<typeof makeBankAccount>[1] = {}) {
    const user = await loginWithRole(DRIVER, 'driver');
    const driverId = await makeDriver(user.userId, { verified: true });
    const accountId = await makeBankAccount(driverId, options);
    return { driverId, accountId };
  }

  const bankUrl = (driverId: string, accountId: string, action: string) =>
    `/api/v1/admin/drivers/${driverId}/bank-accounts/${accountId}/${action}`;

  // ─── intake ──────────────────────────────────────────────────────────────
  it('stores a manually entered account encrypted, and approval does not verify it', async () => {
    const admin = await loginWithRole(ADMIN_A, 'system_admin');
    const nextYear = new Date().getFullYear() + 1;
    const created = await post(admin, '/api/v1/admin/applications', {
      fullName: 'Bank Applicant',
      mobileNumber: '+919876607088',
      email: 'bank.applicant@zaroorat.test',
      gender: 'MALE',
      dateOfBirth: '1994-05-20',
      preferredLanguage: 'English',
      country: 'India',
      state: 'Jammu & Kashmir',
      city: 'Srinagar',
      postcode: '190001',
      addressLine1: 'Residency Road 12',
      emergencyContactName: 'Brother',
      emergencyContactNumber: '+919876607089',
      profilePhotoUrl: 'https://example.invalid/profile.jpg',
      aadhaarNumber: '567856785678',
      aadhaarFrontUrl: 'https://example.invalid/aadhaar-front.jpg',
      aadhaarBackUrl: 'https://example.invalid/aadhaar-back.jpg',
      panNumber: 'ABCDE5678F',
      panUrl: 'https://example.invalid/pan.jpg',
      driverSelfieUrl: 'https://example.invalid/selfie.jpg',
      vehicleType: 'cab',
      vehicleCategory: 'Sedan',
      brand: 'Maruti Suzuki',
      model: 'Swift',
      color: 'White',
      registrationNumber: 'JK-01-BA-5678',
      manufacturingYear: 2022,
      seatCapacity: 4,
      licenseNo: 'JK1420150005678',
      licenseIssueDate: '2020-01-01',
      licenseExpiry: `${nextYear}-01-01`,
      licenseFrontUrl: 'https://example.invalid/license-front.jpg',
      licenseBackUrl: 'https://example.invalid/license-back.jpg',
      rcNumber: 'RC-JK01BA5678',
      rcUrl: 'https://example.invalid/rc.jpg',
      insuranceNo: 'INS-5678',
      insuranceExpiry: `${nextYear}-06-01`,
      insuranceUrl: 'https://example.invalid/insurance.jpg',
      permitNo: 'PRM-5678',
      permitExpiry: `${nextYear}-06-01`,
      permitUrl: 'https://example.invalid/permit.jpg',
      pollutionNo: 'PUC-5678',
      pollutionExpiry: `${nextYear}-06-01`,
      pollutionUrl: 'https://example.invalid/puc.jpg',
      bankAccountName: 'Bank Applicant',
      bankAccountNumber: '1234 5678 9012',
      bankIfsc: 'SBIN0001234',
      bankName: 'State Bank of India',
      registrationAction: 'submit_for_review',
    });
    assert.equal(created.statusCode, 201, created.payload);
    const driverId = created.json().data.id as string;
    const approved = await post(admin, `/api/v1/admin/applications/${driverId}/approve`, {
      notes: 'KYC clear',
    });
    assert.equal(approved.statusCode, 200, approved.payload);

    const account = await db().client.driverBankAccount.findFirstOrThrow({ where: { driverId } });
    assert.equal(account.accountNumberEnc, null, 'no plaintext is written');
    assert.ok(account.accountNumberCiphertext?.startsWith('bank:v1:'));
    assert.equal(decryptAccountNumber(account.accountNumberCiphertext as string), '123456789012');
    assert.equal(account.accountNumberLast4, '9012');
    assert.equal(account.status, 'ENTERED', 'approving the application does not verify the bank');
    assert.equal(account.verificationStatus, 'PENDING');
    assert.equal(account.payoutEnabled, false);
    assert.equal(account.enteredBy, admin.userId);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/drivers/${driverId}`,
      headers: admin.authHeader,
    });
    assert.equal(detail.statusCode, 200, detail.payload);
    assert.equal(detail.json().data.bankAccounts[0].accountNumberMasked, '****9012');
    assert.ok(!detail.payload.includes('123456789012'), 'the full number never leaves the API');
    assert.ok(!detail.payload.includes('bank:v1:'), 'nor does the ciphertext');
  });

  // ─── verification gate ───────────────────────────────────────────────────
  it('needs a second staff member to verify, and the encryption gate to enable payouts', async () => {
    const adminA = await loginWithRole(ADMIN_A, 'admin');
    const adminB = await loginWithRole(ADMIN_B, 'finance');
    const { driverId, accountId } = await driverWithAccount({
      verificationStatus: 'PENDING',
      enteredBy: adminA.userId,
    });

    const self = await post(adminA, bankUrl(driverId, accountId, 'verify'));
    assert.equal(self.statusCode, 403, self.payload);
    assert.equal(self.json().error.code, 'BANK_ACCOUNT_SAME_ACTOR');

    const verified = await post(adminB, bankUrl(driverId, accountId, 'verify'));
    assert.equal(verified.statusCode, 200, verified.payload);
    assert.equal(verified.json().data.status, 'VERIFIED');
    assert.equal(verified.json().data.payoutEnabled, false, 'verifying does not enable payouts');

    await clearBankEncryptionVerified();
    const closed = await post(adminB, bankUrl(driverId, accountId, 'enable-payouts'));
    assert.equal(closed.statusCode, 409, closed.payload);
    assert.equal(closed.json().error.code, 'BANK_ACCOUNT_SECURITY_NOT_READY');

    await markBankEncryptionVerified();
    const enabled = await post(adminB, bankUrl(driverId, accountId, 'enable-payouts'));
    assert.equal(enabled.statusCode, 200, enabled.payload);
    assert.equal(enabled.json().data.status, 'PAYOUT_ENABLED');
    assert.equal(enabled.json().data.payoutEnabled, true);

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/drivers/${driverId}/bank-accounts`,
      headers: adminB.authHeader,
    });
    assert.equal(list.statusCode, 200, list.payload);
    assert.match(list.json().data[0].accountNumberMasked, /^\*{4}\d{4}$/);
    assert.ok(!list.payload.includes('bank:v1:'));
    assert.ok(!('accountNumberCiphertext' in list.json().data[0]));

    const audits = await db().client.adminActivityLog.count({
      where: { entityType: 'driver_bank_account', entityId: accountId },
    });
    assert.equal(audits, 2, 'verify and enable are both audited');
  });

  it('refuses illegal transitions, and deactivation turns payouts off', async () => {
    const admin = await loginWithRole(ADMIN_B, 'finance');
    const { driverId, accountId } = await driverWithAccount();

    const again = await post(admin, bankUrl(driverId, accountId, 'verify'));
    assert.equal(again.statusCode, 409, again.payload);
    assert.equal(again.json().error.code, 'BANK_ACCOUNT_INVALID_TRANSITION');

    const deactivated = await post(admin, bankUrl(driverId, accountId, 'deactivate'), {
      reason: 'Driver closed the account',
    });
    assert.equal(deactivated.statusCode, 200, deactivated.payload);
    assert.equal(deactivated.json().data.status, 'DEACTIVATED');
    assert.equal(deactivated.json().data.payoutEnabled, false);
    assert.equal(deactivated.json().data.isActive, false);

    assert.equal(
      (await post(admin, bankUrl(driverId, accountId, 'enable-payouts'))).statusCode,
      409,
    );
  });

  it('refuses a driver’s account through another driver’s path', async () => {
    const admin = await loginWithRole(ADMIN_B, 'finance');
    const { accountId } = await driverWithAccount({ verificationStatus: 'PENDING' });

    const response = await post(admin, bankUrl(randomUUID(), accountId, 'verify'));
    assert.equal(response.statusCode, 404, response.payload);
  });

  it('has the database refuse payoutEnabled without PAYOUT_ENABLED on an active account', async () => {
    const { accountId } = await driverWithAccount({ verificationStatus: 'PENDING' });
    await assert.rejects(
      db().client.driverBankAccount.update({
        where: { id: accountId },
        data: { payoutEnabled: true },
      }),
    );
  });

  // ─── payout gate ─────────────────────────────────────────────────────────
  it('pays out only to an active, payout-enabled, encrypted account behind the gate', async () => {
    const finance = await loginWithRole(FINANCE, 'finance');
    const user = await loginWithRole(DRIVER, 'driver');
    const driverId = await makeDriver(user.userId, { verified: true });
    const settlementId = await makeSettlement(driverId, 1000);
    const payout = (bankAccountId: string) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/admin/payments/payouts',
        headers: { ...finance.authHeader, 'idempotency-key': randomUUID() },
        payload: { driverId, settlementId, bankAccountId, amount: 100 },
      });

    const inactive = await makeBankAccount(driverId, { isActive: false });
    assert.equal((await payout(inactive)).json().error.code, 'PAYOUT_BANK_ACCOUNT_INACTIVE');

    const unencrypted = await makeBankAccount(driverId, { encrypted: false });
    assert.equal((await payout(unencrypted)).json().error.code, 'PAYOUT_BANK_SECURITY_NOT_READY');

    const good = await makeBankAccount(driverId);
    await clearBankEncryptionVerified();
    assert.equal((await payout(good)).json().error.code, 'PAYOUT_BANK_SECURITY_NOT_READY');

    await markBankEncryptionVerified();
    const ok = await payout(good);
    assert.equal(ok.statusCode, 200, ok.payload);
  });

  // ─── expand → backfill → verify ──────────────────────────────────────────
  it('backfills legacy plaintext without touching it, and only a clean verification opens the gate', async () => {
    const user = await loginWithRole(DRIVER, 'driver');
    const driverId = await makeDriver(user.userId, { verified: true });
    const legacy = await db().client.driverBankAccount.create({
      data: {
        driverId,
        accountHolderName: 'Legacy',
        ifscCode: 'HDFC0001234',
        accountNumberEnc: '4444 5555 6666',
      },
    });
    await clearBankEncryptionVerified();

    const before = await verifyBankAccountEncryption(db().client);
    assert.equal(before.verifiedAt, null);
    assert.equal(before.failed[0]?.reason, 'not encrypted');

    const dryRun = await backfillBankAccountEncryption(db().client, { dryRun: true });
    assert.equal(dryRun.encrypted, 1);
    assert.equal(
      (await db().client.driverBankAccount.findUniqueOrThrow({ where: { id: legacy.id } }))
        .accountNumberCiphertext,
      null,
      'a dry run writes nothing',
    );

    const run = await backfillBankAccountEncryption(db().client);
    assert.deepEqual(
      { encrypted: run.encrypted, failed: run.failed },
      { encrypted: 1, failed: [] },
    );
    const row = await db().client.driverBankAccount.findUniqueOrThrow({ where: { id: legacy.id } });
    assert.equal(row.accountNumberEnc, '4444 5555 6666', 'the legacy value is preserved');
    assert.equal(decryptAccountNumber(row.accountNumberCiphertext as string), '444455556666');
    assert.equal(row.accountNumberLast4, '6666');

    const rerun = await backfillBankAccountEncryption(db().client);
    assert.equal(rerun.encrypted, 0, 'idempotent');

    const verified = await verifyBankAccountEncryption(db().client);
    assert.ok(verified.verifiedAt);
    assert.ok(
      await db().client.systemSetting.findUnique({
        where: { key: BANK_ENCRYPTION_VERIFIED_SETTING },
      }),
    );

    // Tampering with any row closes the gate again.
    await db().client.driverBankAccount.update({
      where: { id: legacy.id },
      data: { accountNumberLast4: '0000' },
    });
    const tampered = await verifyBankAccountEncryption(db().client);
    assert.equal(tampered.verifiedAt, null);
    assert.equal(
      await db().client.systemSetting.findUnique({
        where: { key: BANK_ENCRYPTION_VERIFIED_SETTING },
      }),
      null,
    );
    assert.ok(!JSON.stringify(tampered).includes('4444'), 'reports never carry a number');
  });

  it('redacts account numbers from logs', () => {
    for (const field of ['accountNumber', 'accountNumberEnc', 'bankAccountNumber']) {
      assert.ok(REDACT_PATHS.includes(field), field);
      assert.ok(REDACT_PATHS.includes(`*.${field}`), `*.${field}`);
    }
  });
});

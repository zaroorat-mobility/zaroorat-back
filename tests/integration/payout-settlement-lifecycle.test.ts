import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { container } from '../../src/core/di.js';
import { bootApp, db, loginAs, resetState, type LoggedInUser } from './helpers/harness.js';
import {
  driverWalletBalance,
  grantRole,
  makeBankAccount,
  makeDriver,
  makeSettlement,
} from './helpers/fixtures.js';
import { Decimal } from '../../src/modules/payments/types/index.js';
import { SettlementService } from '../../src/modules/payments/services/settlement/settlement.service.js';

const FINANCE = '+919876603001';
const DRIVER = '+919876603002';
const OTHER_DRIVER = '+919876603003';

const settlements = () => container.resolve<SettlementService>('settlementService');

/// Payout/settlement Option A.
///
/// The whole point of this suite is one claim: `PAID` on a `DriverSettlement`
/// means money reached a driver, and nothing else in the system may write it.
/// Before Option A three separate paths wrote `PAID` with no payout at all —
/// the settlement job wrote it in the same transaction that created the row,
/// admin batch completion cascaded it onto every child, and the payout path
/// wrote it whenever a gateway call merely failed to throw.
describe('payout + settlement lifecycle (integration, real HTTP)', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await bootApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(async () => {
    await resetState();
  });

  async function loginWithRole(phone: string, role: string): Promise<LoggedInUser> {
    const user = await loginAs(app, phone);
    await grantRole(user.userId, role);
    return loginAs(app, phone);
  }

  function initiate(user: LoggedInUser, body: Record<string, unknown>, key = randomUUID()) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/admin/payments/payouts',
      headers: { ...user.authHeader, 'idempotency-key': key },
      payload: body,
    });
  }

  function confirm(user: LoggedInUser, payoutId: string, externalReference = `UTR${randomUUID()}`) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/admin/payments/payouts/${payoutId}/confirm`,
      headers: user.authHeader,
      payload: { externalReference },
    });
  }

  function fail(user: LoggedInUser, payoutId: string, reason = 'Bank rejected the transfer') {
    return app.inject({
      method: 'POST',
      url: `/api/v1/admin/payments/payouts/${payoutId}/fail`,
      headers: user.authHeader,
      payload: { reason },
    });
  }

  async function seed(netPayable: number) {
    const finance = await loginWithRole(FINANCE, 'finance');
    const driverUser = await loginWithRole(DRIVER, 'driver');
    const driverId = await makeDriver(driverUser.userId, { verified: true });
    const settlementId = await makeSettlement(driverId, netPayable);
    const bankAccountId = await makeBankAccount(driverId);
    return { finance, driverId, settlementId, bankAccountId };
  }

  async function settlementStatus(id: string): Promise<string> {
    const row = await db().client.driverSettlement.findUniqueOrThrow({ where: { id } });
    return row.status;
  }

  /// Net position of one account in the ledger: debits minus credits.
  async function ledgerNet(account: string, accountRefId?: string): Promise<number> {
    const rows = await db().client.paymentLedgerEntry.findMany({
      where: { account, ...(accountRefId ? { accountRefId } : {}) },
    });
    return rows.reduce(
      (sum, r) => sum + (r.direction === 'DEBIT' ? 1 : -1) * Number(r.amount.toString()),
      0,
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  describe('settlement calculation never pays anybody', () => {
    it('leaves a calculated settlement PENDING, with no payout in existence', async () => {
      const driverUser = await loginWithRole(DRIVER, 'driver');
      const driverId = await makeDriver(driverUser.userId, { verified: true });
      const periodEnd = new Date();
      const periodStart = new Date(periodEnd.getTime() - 24 * 60 * 60 * 1000);

      const settlement = await settlements().calculateSettlement({
        driverId,
        periodStart,
        periodEnd,
      });

      assert.equal(
        settlement.status,
        'PENDING',
        'calculating what a driver is owed is not paying them',
      );
      assert.equal(
        await db().client.driverPayout.count({ where: { driverId } }),
        0,
        'and it creates no payout at all',
      );
    });

    it('still leaves it PENDING when there are genuine earnings to credit', async () => {
      const { settlementId, driverId } = await seed(750);

      assert.equal(await settlementStatus(settlementId), 'PENDING');
      assert.equal(
        await driverWalletBalance(driverId),
        750,
        'the wallet is credited — that part was always right',
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('admin batch completion never creates a false PAID', () => {
    /// Takes the already-authenticated finance user rather than logging one in
    /// itself — a second `loginAs` for the same phone inside a test trips the
    /// OTP rate limiter, which has nothing to do with what is under test here.
    async function batchFor(finance: LoggedInUser, settlementId: string, status: string) {
      const settlement = await db().client.driverSettlement.findUniqueOrThrow({
        where: { id: settlementId },
      });
      const batch = await db().client.settlementBatch.create({
        data: {
          batchNumber: `BATCH-${randomUUID().slice(0, 8)}`,
          periodStart: settlement.periodStart,
          periodEnd: settlement.periodEnd,
          status: 'draft',
          generatedBy: 'test',
          totalDrivers: 1,
          totalNetPayable: settlement.netPayable,
        },
      });
      await db().client.driverSettlement.update({
        where: { id: settlementId },
        data: { settlementBatchId: batch.id },
      });
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/finance/settlements/${batch.id}/status`,
        headers: finance.authHeader,
        payload: { status },
      });
      assert.equal(response.statusCode, 200, response.payload);
      return batch.id;
    }

    it('completing a batch does not mark its drivers PAID', async () => {
      const { finance, settlementId } = await seed(1000);

      await batchFor(finance, settlementId, 'completed');

      assert.notEqual(
        await settlementStatus(settlementId),
        'PAID',
        'a dispatched batch is not a paid driver',
      );
    });

    it('approving a batch moves its drivers to APPROVED, not PAID', async () => {
      const { finance, settlementId } = await seed(1000);

      await batchFor(finance, settlementId, 'pending');

      assert.equal(await settlementStatus(settlementId), 'APPROVED');
    });

    it('processing a batch moves its drivers to PROCESSING', async () => {
      const { finance, settlementId } = await seed(1000);

      await batchFor(finance, settlementId, 'processing');

      assert.equal(await settlementStatus(settlementId), 'PROCESSING');
    });

    it('never walks an already-PAID settlement back out of PAID', async () => {
      const { finance, settlementId, driverId, bankAccountId } = await seed(400);
      const created = await initiate(finance, {
        driverId,
        settlementId,
        bankAccountId,
        amount: 400,
      });
      assert.equal(created.statusCode, 200, created.payload);
      await confirm(finance, created.json().data.id);
      assert.equal(await settlementStatus(settlementId), 'PAID');

      // A batch transition must never re-open a completed money movement for a
      // second payout.
      await batchFor(finance, settlementId, 'failed');

      assert.equal(await settlementStatus(settlementId), 'PAID');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('manual payout state machine', () => {
    it('initiates INITIATED, confirms COMPLETED, and only then settles the period', async () => {
      const { finance, driverId, settlementId, bankAccountId } = await seed(1000);

      const created = await initiate(finance, {
        driverId,
        settlementId,
        bankAccountId,
        amount: 1000,
      });
      assert.equal(created.statusCode, 200, created.payload);
      assert.equal(created.json().data.status, 'INITIATED');
      assert.equal(await settlementStatus(settlementId), 'PENDING', 'nothing has moved yet');

      const confirmed = await confirm(finance, created.json().data.id, 'UTR-ABC-123');
      assert.equal(confirmed.statusCode, 200, confirmed.payload);
      assert.equal(confirmed.json().data.status, 'COMPLETED');
      assert.equal(confirmed.json().data.externalReference, 'UTR-ABC-123');
      assert.equal(await settlementStatus(settlementId), 'PAID');
    });

    it('leaves a partially confirmed settlement unpaid', async () => {
      const { finance, driverId, settlementId, bankAccountId } = await seed(1000);

      const created = await initiate(finance, {
        driverId,
        settlementId,
        bankAccountId,
        amount: 600,
      });
      await confirm(finance, created.json().data.id);

      assert.equal(
        await settlementStatus(settlementId),
        'PENDING',
        '600 of 1000 paid is not a paid period',
      );
    });

    it('refuses to confirm a payout twice', async () => {
      const { finance, driverId, settlementId, bankAccountId } = await seed(500);
      const created = await initiate(finance, {
        driverId,
        settlementId,
        bankAccountId,
        amount: 500,
      });
      const payoutId = created.json().data.id;

      assert.equal((await confirm(finance, payoutId)).statusCode, 200);
      const second = await confirm(finance, payoutId);

      assert.equal(second.statusCode, 409, second.payload);
      assert.equal(second.json().error.code, 'PAYOUT_NOT_PENDING');
    });

    it('refuses to confirm a payout that was already failed', async () => {
      const { finance, driverId, settlementId, bankAccountId } = await seed(500);
      const created = await initiate(finance, {
        driverId,
        settlementId,
        bankAccountId,
        amount: 500,
      });
      const payoutId = created.json().data.id;

      assert.equal((await fail(finance, payoutId)).statusCode, 200);
      assert.equal((await confirm(finance, payoutId)).statusCode, 409);
    });

    it('404s on confirming a payout that does not exist', async () => {
      const finance = await loginWithRole(FINANCE, 'finance');

      const response = await confirm(finance, randomUUID());

      assert.equal(response.statusCode, 404, response.payload);
      assert.equal(response.json().error.code, 'PAYOUT_NOT_FOUND');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('an already-paid settlement is closed for business', () => {
    it('refuses a new payout once the settlement is PAID', async () => {
      const { finance, driverId, settlementId, bankAccountId } = await seed(300);
      const created = await initiate(finance, {
        driverId,
        settlementId,
        bankAccountId,
        amount: 300,
      });
      await confirm(finance, created.json().data.id);
      assert.equal(await settlementStatus(settlementId), 'PAID');

      // Top the wallet back up so the refusal is provably about the settlement
      // being closed, not about an incidentally empty wallet.
      await db().client.driverWallet.update({
        where: { driverId },
        data: { balance: { increment: 1000 } },
      });

      const again = await initiate(finance, {
        driverId,
        settlementId,
        bankAccountId,
        amount: 100,
      });

      assert.equal(again.statusCode, 422, again.payload);
      assert.equal(again.json().error.code, 'SETTLEMENT_NOT_PAYABLE');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('bank account validation', () => {
    it("refuses another driver's bank account", async () => {
      const { finance, driverId, settlementId } = await seed(1000);
      const otherUser = await loginWithRole(OTHER_DRIVER, 'driver');
      const otherDriverId = await makeDriver(otherUser.userId, { verified: true });
      const foreignAccount = await makeBankAccount(otherDriverId);

      const response = await initiate(finance, {
        driverId,
        settlementId,
        bankAccountId: foreignAccount,
        amount: 100,
      });

      assert.equal(response.statusCode, 422, response.payload);
      assert.equal(response.json().error.code, 'PAYOUT_BANK_ACCOUNT_INVALID');
    });

    it('refuses a bank account that does not exist', async () => {
      const { finance, driverId, settlementId } = await seed(1000);

      const response = await initiate(finance, {
        driverId,
        settlementId,
        bankAccountId: randomUUID(),
        amount: 100,
      });

      assert.equal(response.statusCode, 422, response.payload);
      assert.equal(response.json().error.code, 'PAYOUT_BANK_ACCOUNT_INVALID');
    });

    it('refuses an unverified bank account', async () => {
      const { finance, driverId, settlementId } = await seed(1000);
      const pending = await makeBankAccount(driverId, { verificationStatus: 'PENDING' });

      const response = await initiate(finance, {
        driverId,
        settlementId,
        bankAccountId: pending,
        amount: 100,
      });

      assert.equal(response.statusCode, 422, response.payload);
      assert.equal(response.json().error.code, 'PAYOUT_BANK_ACCOUNT_NOT_VERIFIED');
    });

    it('refuses a verified account that is not payout-enabled', async () => {
      const { finance, driverId, settlementId } = await seed(1000);
      const notEnabled = await makeBankAccount(driverId, { payoutEnabled: false });

      const response = await initiate(finance, {
        driverId,
        settlementId,
        bankAccountId: notEnabled,
        amount: 100,
      });

      assert.equal(response.statusCode, 422, response.payload);
      assert.equal(response.json().error.code, 'PAYOUT_BANK_ACCOUNT_NOT_ENABLED');
    });

    it('requires a bank account at all', async () => {
      const { finance, driverId, settlementId } = await seed(1000);

      const response = await initiate(finance, { driverId, settlementId, amount: 100 });

      assert.equal(response.statusCode, 400, response.payload);
      assert.equal(await db().client.driverPayout.count({ where: { driverId } }), 0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('driver wallet accounting', () => {
    it('debits the wallet exactly once, at confirmation and not before', async () => {
      const { finance, driverId, settlementId, bankAccountId } = await seed(1000);
      assert.equal(await driverWalletBalance(driverId), 1000);

      const created = await initiate(finance, {
        driverId,
        settlementId,
        bankAccountId,
        amount: 400,
      });
      assert.equal(
        await driverWalletBalance(driverId),
        1000,
        'initiating reserves; it does not debit',
      );

      await confirm(finance, created.json().data.id);
      assert.equal(await driverWalletBalance(driverId), 600);

      // The guard that makes it exactly-once.
      await confirm(finance, created.json().data.id);
      assert.equal(
        await driverWalletBalance(driverId),
        600,
        'a repeat confirmation debits nothing',
      );

      const debits = await db().client.driverWalletTransaction.count({
        where: { driverId, referenceType: 'PAYOUT' },
      });
      assert.equal(debits, 1, 'and leaves exactly one wallet transaction');
    });

    it('records the payout debit as a WITHDRAWAL, not a PENALTY', async () => {
      const { finance, driverId, settlementId, bankAccountId } = await seed(500);
      const created = await initiate(finance, {
        driverId,
        settlementId,
        bankAccountId,
        amount: 500,
      });
      await confirm(finance, created.json().data.id);

      const txn = await db().client.driverWalletTransaction.findFirstOrThrow({
        where: { driverId, referenceType: 'PAYOUT' },
      });
      assert.equal(txn.txnType, 'WITHDRAWAL');
      assert.equal(Number(txn.amount.toString()), -500, 'debits are stored negative');
    });

    it('never lets a payout drive the wallet negative', async () => {
      const { finance, driverId, settlementId, bankAccountId } = await seed(1000);
      // A cash-ride clawback has since eaten most of the balance. The
      // settlement still says 1000 is owed for the period; the wallet says
      // only 250 is actually there, and the wallet wins.
      await db().client.driverWallet.update({
        where: { driverId },
        data: { balance: new Decimal(250) },
      });

      const response = await initiate(finance, {
        driverId,
        settlementId,
        bankAccountId,
        amount: 900,
      });

      assert.equal(response.statusCode, 422, response.payload);
      assert.equal(response.json().error.code, 'PAYOUT_EXCEEDS_WALLET_BALANCE');
      assert.equal(await driverWalletBalance(driverId), 250);
    });

    it('refuses at confirmation too, if the balance drained after initiation', async () => {
      const { finance, driverId, settlementId, bankAccountId } = await seed(1000);
      const created = await initiate(finance, {
        driverId,
        settlementId,
        bankAccountId,
        amount: 800,
      });

      // Something else legitimately took the money in between — a cash debt
      // recovery. Confirming now would overdraw the wallet.
      await db().client.driverWallet.update({
        where: { driverId },
        data: { balance: new Decimal(100) },
      });

      const confirmed = await confirm(finance, created.json().data.id);

      assert.equal(confirmed.statusCode, 422, confirmed.payload);
      assert.equal(confirmed.json().error.code, 'PAYOUT_EXCEEDS_WALLET_BALANCE');
      assert.equal(await driverWalletBalance(driverId), 100, 'and the wallet is untouched');
      assert.equal(await settlementStatus(settlementId), 'PENDING');
    });

    it('keeps exactly one debit under concurrent confirmations', async () => {
      const { finance, driverId, settlementId, bankAccountId } = await seed(1000);
      const created = await initiate(finance, {
        driverId,
        settlementId,
        bankAccountId,
        amount: 700,
      });
      const payoutId = created.json().data.id;

      const results = await Promise.all([
        confirm(finance, payoutId),
        confirm(finance, payoutId),
        confirm(finance, payoutId),
      ]);

      assert.equal(
        results.filter((r) => r.statusCode === 200).length,
        1,
        'exactly one confirmation wins',
      );
      assert.equal(await driverWalletBalance(driverId), 300);
      assert.equal(
        await db().client.driverWalletTransaction.count({
          where: { driverId, referenceType: 'PAYOUT' },
        }),
        1,
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('failed payouts stay auditable', () => {
    it('keeps the row, its reason and its reservation release', async () => {
      const { finance, driverId, settlementId, bankAccountId } = await seed(1000);
      const created = await initiate(finance, {
        driverId,
        settlementId,
        bankAccountId,
        amount: 1000,
      });
      const payoutId = created.json().data.id;

      const failed = await fail(finance, payoutId, 'IFSC rejected by beneficiary bank');
      assert.equal(failed.statusCode, 200, failed.payload);

      // The previous implementation wrote FAILED and rethrew from inside the
      // same transaction, so the row vanished with the rollback. It must not.
      const row = await db().client.driverPayout.findUniqueOrThrow({ where: { id: payoutId } });
      assert.equal(row.status, 'FAILED');
      assert.equal(row.failureReason, 'IFSC rejected by beneficiary bank');
      assert.equal(row.completedAt, null);

      assert.equal(await driverWalletBalance(driverId), 1000, 'a failure moves no money');
      assert.equal(await settlementStatus(settlementId), 'PENDING');
    });

    it('releases the reserved amount so the settlement can be paid again', async () => {
      const { finance, driverId, settlementId, bankAccountId } = await seed(1000);
      const first = await initiate(finance, {
        driverId,
        settlementId,
        bankAccountId,
        amount: 1000,
      });
      await fail(finance, first.json().data.id);

      const retry = await initiate(finance, {
        driverId,
        settlementId,
        bankAccountId,
        amount: 1000,
      });

      assert.equal(retry.statusCode, 200, retry.payload);
      await confirm(finance, retry.json().data.id);
      assert.equal(await settlementStatus(settlementId), 'PAID');
      assert.equal(await driverWalletBalance(driverId), 0);
    });

    it('writes an admin activity log for both the initiation and the outcome', async () => {
      const { finance, driverId, settlementId, bankAccountId } = await seed(500);
      const created = await initiate(finance, {
        driverId,
        settlementId,
        bankAccountId,
        amount: 500,
      });
      await fail(finance, created.json().data.id, 'Beneficiary account closed');

      const logs = await db().client.adminActivityLog.findMany({
        where: { entityType: 'driver_payout', entityId: created.json().data.id },
      });
      assert.equal(logs.length, 2, 'one for the initiation, one for the failure');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('ledger and wallet stay consistent', () => {
    it('relieves DRIVER_PAYABLE and credits BANK_CLEARING by the same amount', async () => {
      const { finance, driverId, settlementId, bankAccountId } = await seed(900);

      const payableBefore = await ledgerNet('DRIVER_PAYABLE', driverId);
      const created = await initiate(finance, {
        driverId,
        settlementId,
        bankAccountId,
        amount: 900,
      });

      assert.equal(
        await ledgerNet('DRIVER_PAYABLE', driverId),
        payableBefore,
        'initiation posts nothing to the ledger',
      );

      await confirm(finance, created.json().data.id);

      assert.equal(
        await ledgerNet('DRIVER_PAYABLE', driverId),
        payableBefore + 900,
        'the payable is relieved by exactly the payout',
      );
      assert.equal(
        await ledgerNet('BANK_CLEARING'),
        -900,
        'and the money is shown leaving the bank account, not a gateway',
      );
      assert.equal(
        await ledgerNet('GATEWAY_CLEARING'),
        0,
        'a manual bank transfer never touches gateway clearing',
      );
    });

    it('moves the wallet and the ledger by the same amount, or neither', async () => {
      const { finance, driverId, settlementId, bankAccountId } = await seed(600);
      const created = await initiate(finance, {
        driverId,
        settlementId,
        bankAccountId,
        amount: 250,
      });
      await confirm(finance, created.json().data.id);

      const walletDrop = 600 - (await driverWalletBalance(driverId));
      const payableRelief = await ledgerNet('DRIVER_PAYABLE', driverId);

      assert.equal(walletDrop, 250);
      assert.equal(payableRelief, 250);
      assert.equal(walletDrop, payableRelief, 'wallet and ledger never disagree about a payout');
    });

    it('posts a balanced ledger group', async () => {
      const { finance, driverId, settlementId, bankAccountId } = await seed(300);
      const created = await initiate(finance, {
        driverId,
        settlementId,
        bankAccountId,
        amount: 300,
      });
      await confirm(finance, created.json().data.id);

      const entries = await db().client.paymentLedgerEntry.findMany({
        where: { referenceType: 'PAYOUT', referenceId: created.json().data.id },
      });
      assert.equal(entries.length, 2);
      assert.equal(
        new Set(entries.map((e) => e.entryGroup)).size,
        1,
        'both legs share one entry group',
      );
      const net = entries.reduce(
        (sum, e) => sum + (e.direction === 'DEBIT' ? 1 : -1) * Number(e.amount.toString()),
        0,
      );
      assert.equal(net, 0, 'debits equal credits');
    });
  });
});

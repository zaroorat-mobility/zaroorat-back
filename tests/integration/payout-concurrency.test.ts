import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { container } from '../../src/core/di.js';
import type { TransactionManager } from '../../src/core/database/TransactionManager.js';
import { bootApp, db, loginAs, resetState, type LoggedInUser } from './helpers/harness.js';
import { grantRole, makeBankAccount, makeDriver, makeSettlement } from './helpers/fixtures.js';
import { Decimal } from '../../src/modules/payments/types/index.js';
import type { SettlementWalletRepository } from '../../src/modules/payments/repositories/settlement-wallet.repository.js';

const FINANCE = '+919876604001';
const DRIVER = '+919876604002';

const walletRepo = () =>
  container.resolve<SettlementWalletRepository>('settlementWalletRepository');
const txManager = () => container.resolve<TransactionManager>('transactionManager');

/// Option A safety hotfix (D12) — payout concurrency.
///
/// Two properties, both about money that has not moved yet:
///
///  1. A payout reserves its amount in `driver_wallets.locked_balance` at
///     initiation, and `availableBalance = balance − lockedBalance` is what
///     every later payout is checked against. The same rupees can therefore
///     never be promised to two payouts — not on one settlement, not across
///     two settlements, and not across the manual and (future) RazorpayX rails,
///     which share this one wallet row.
///  2. Every payout path takes row locks in ONE order:
///     DriverPayout → DriverSettlement → DriverWallet. Before this fix,
///     confirmation locked payout → wallet → settlement while initiation
///     locked settlement → wallet, so the two could deadlock.
///
/// Every test ends by checking the invariant that ties the two together:
/// the wallet's locked amount is exactly the sum of that driver's INITIATED
/// payouts, and never exceeds the balance.
describe('payout concurrency and reservations (integration, real HTTP)', () => {
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

  function initiate(
    user: LoggedInUser,
    body: { driverId: string; settlementId: string; bankAccountId: string; amount: number },
    key = randomUUID(),
  ) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/admin/payments/payouts',
      headers: { ...user.authHeader, 'idempotency-key': key },
      payload: body,
    });
  }

  function confirm(user: LoggedInUser, payoutId: string) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/admin/payments/payouts/${payoutId}/confirm`,
      headers: user.authHeader,
      payload: { externalReference: `UTR${randomUUID().slice(0, 12)}` },
    });
  }

  function fail(user: LoggedInUser, payoutId: string) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/admin/payments/payouts/${payoutId}/fail`,
      headers: user.authHeader,
      payload: { reason: 'Bank rejected the transfer' },
    });
  }

  async function seed() {
    const finance = await loginWithRole(FINANCE, 'finance');
    const driverUser = await loginWithRole(DRIVER, 'driver');
    const driverId = await makeDriver(driverUser.userId, { verified: true });
    const bankAccountId = await makeBankAccount(driverId);
    return { finance, driverId, bankAccountId };
  }

  async function wallet(driverId: string): Promise<{ balance: number; locked: number }> {
    const row = await db().client.driverWallet.findUniqueOrThrow({ where: { driverId } });
    return {
      balance: Number(row.balance.toString()),
      locked: Number(row.lockedBalance.toString()),
    };
  }

  /// The real cash-ride clawback primitive (`SettlementWalletRepository.debit`),
  /// run in its own transaction exactly as collection runs it.
  function clawback(driverId: string, amount: number) {
    return txManager().execute((tx) =>
      walletRepo().debit(
        {
          driverId,
          amount: new Decimal(amount),
          referenceType: 'RIDE',
          referenceId: randomUUID(),
          description: 'Test cash-ride clawback',
        },
        tx,
      ),
    );
  }

  /// The real settlement/referral credit primitive.
  function credit(driverId: string, amount: number) {
    return txManager().execute((tx) =>
      walletRepo().credit(
        {
          driverId,
          amount: new Decimal(amount),
          referenceType: 'SETTLEMENT',
          referenceId: randomUUID(),
          description: 'Test earnings credit',
        },
        tx,
      ),
    );
  }

  async function withdrawals(driverId: string): Promise<number> {
    return db().client.driverWalletTransaction.count({
      where: { driverId, referenceType: 'PAYOUT', txnType: 'WITHDRAWAL' },
    });
  }

  async function assertReservationInvariant(driverId: string): Promise<void> {
    const { balance, locked } = await wallet(driverId);
    const initiated = await db().client.driverPayout.aggregate({
      where: { driverId, status: 'INITIATED' },
      _sum: { amount: true },
    });
    const reserved = Number((initiated._sum.amount ?? new Decimal(0)).toString());
    assert.equal(locked, reserved, 'lockedBalance must equal the sum of INITIATED payouts');
    assert.ok(locked >= 0, `lockedBalance must never be negative (was ${locked})`);
    assert.ok(locked <= balance, `lockedBalance ${locked} must never exceed balance ${balance}`);
  }

  function assertNoServerError(responses: { statusCode: number; payload: string }[]): void {
    for (const r of responses) {
      assert.ok(r.statusCode < 500, `no request may fail with a 5xx (deadlock): ${r.payload}`);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  describe('lock order', () => {
    it('never deadlocks when confirmations and new initiations race on one settlement', async () => {
      const { finance, driverId, bankAccountId } = await seed();
      const settlementId = await makeSettlement(driverId, 3000);

      // Five payouts already awaiting confirmation…
      const pending: string[] = [];
      for (let i = 0; i < 5; i++) {
        const r = await initiate(finance, { driverId, settlementId, bankAccountId, amount: 300 });
        assert.equal(r.statusCode, 200, r.payload);
        pending.push(r.json().data.id);
      }

      // …confirmed while five more are raised against the same settlement and
      // the same wallet. Before the fix these took the two row locks in
      // opposite orders.
      const results = await Promise.all([
        ...pending.map((id) => confirm(finance, id)),
        ...Array.from({ length: 5 }, () =>
          initiate(finance, { driverId, settlementId, bankAccountId, amount: 300 }),
        ),
      ]);

      assertNoServerError(results);
      assert.ok(
        results.every((r) => r.statusCode === 200),
        `every request succeeds: ${results.map((r) => r.statusCode).join(',')}`,
      );
      assert.deepEqual(await wallet(driverId), { balance: 1500, locked: 1500 });
      assert.equal(await withdrawals(driverId), 5);
      await assertReservationInvariant(driverId);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('the same wallet money can never be reserved twice', () => {
    it('admits only one of two concurrent payouts the wallet can fund once', async () => {
      const { finance, driverId, bankAccountId } = await seed();
      const settlementId = await makeSettlement(driverId, 1000);
      // A cash-ride clawback leaves 500 in the wallet. The settlement still
      // says 1000 is owed; the wallet is now the binding limit.
      await clawback(driverId, 500);

      const results = await Promise.all([
        initiate(finance, { driverId, settlementId, bankAccountId, amount: 400 }),
        initiate(finance, { driverId, settlementId, bankAccountId, amount: 400 }),
      ]);

      assertNoServerError(results);
      assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 422]);
      const refused = results.find((r) => r.statusCode === 422);
      assert.equal(refused?.json().error.code, 'PAYOUT_EXCEEDS_WALLET_BALANCE');
      assert.deepEqual(await wallet(driverId), { balance: 500, locked: 400 });
      await assertReservationInvariant(driverId);
    });

    it('holds across two settlements of the same driver', async () => {
      const { finance, driverId, bankAccountId } = await seed();
      const first = await makeSettlement(driverId, 600);
      const second = await makeSettlement(driverId, 600);
      // 1200 credited, 400 clawed back: 800 is really there. Each settlement
      // on its own would allow 600 — together they must not promise 1200.
      await clawback(driverId, 400);

      const results = await Promise.all([
        initiate(finance, { driverId, settlementId: first, bankAccountId, amount: 600 }),
        initiate(finance, { driverId, settlementId: second, bankAccountId, amount: 600 }),
      ]);

      assertNoServerError(results);
      assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 422]);
      assert.deepEqual(await wallet(driverId), { balance: 800, locked: 600 });
      await assertReservationInvariant(driverId);

      const winner = results.find((r) => r.statusCode === 200)?.json().data.id as string;
      assert.equal((await confirm(finance, winner)).statusCode, 200);
      assert.deepEqual(await wallet(driverId), { balance: 200, locked: 0 });
      assert.equal(await withdrawals(driverId), 1);
      await assertReservationInvariant(driverId);
    });

    it('admits exactly as many of many concurrent payouts as available money covers', async () => {
      const { finance, driverId, bankAccountId } = await seed();
      const settlementId = await makeSettlement(driverId, 5000);
      await clawback(driverId, 4000); // 1000 really available

      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          initiate(finance, { driverId, settlementId, bankAccountId, amount: 300 }),
        ),
      );

      assertNoServerError(results);
      assert.equal(results.filter((r) => r.statusCode === 200).length, 3, '3 × 300 fits in 1000');
      assert.deepEqual(await wallet(driverId), { balance: 1000, locked: 900 });
      await assertReservationInvariant(driverId);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('payouts racing other wallet operations', () => {
    it('stays consistent when an initiation races a credit and a cash clawback', async () => {
      const { finance, driverId, bankAccountId } = await seed();
      const settlementId = await makeSettlement(driverId, 1000);

      // Whatever order these serialise in, at least 800 is available when the
      // payout checks, so it must succeed — and nothing may 5xx.
      const [payout] = await Promise.all([
        initiate(finance, { driverId, settlementId, bankAccountId, amount: 300 }),
        credit(driverId, 100),
        clawback(driverId, 200),
      ]);

      assertNoServerError([payout]);
      assert.equal(payout.statusCode, 200, payout.payload);
      assert.deepEqual(await wallet(driverId), { balance: 900, locked: 300 });
      await assertReservationInvariant(driverId);
    });

    it('stays consistent when a confirmation races a cash clawback', async () => {
      const { finance, driverId, bankAccountId } = await seed();
      const settlementId = await makeSettlement(driverId, 1000);
      const created = await initiate(finance, {
        driverId,
        settlementId,
        bankAccountId,
        amount: 300,
      });

      const [confirmed] = await Promise.all([
        confirm(finance, created.json().data.id),
        clawback(driverId, 200),
      ]);

      assertNoServerError([confirmed]);
      assert.equal(confirmed.statusCode, 200, confirmed.payload);
      assert.deepEqual(await wallet(driverId), { balance: 500, locked: 0 });
      assert.equal(await withdrawals(driverId), 1);
      await assertReservationInvariant(driverId);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('exactly-once settlement of a reservation', () => {
    it('never records a second withdrawal under concurrent confirmations', async () => {
      const { finance, driverId, bankAccountId } = await seed();
      const settlementId = await makeSettlement(driverId, 1000);
      const created = await initiate(finance, {
        driverId,
        settlementId,
        bankAccountId,
        amount: 700,
      });
      const id = created.json().data.id as string;

      const results = await Promise.all([
        confirm(finance, id),
        confirm(finance, id),
        confirm(finance, id),
      ]);

      assertNoServerError(results);
      assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409, 409]);
      assert.deepEqual(await wallet(driverId), { balance: 300, locked: 0 });
      assert.equal(await withdrawals(driverId), 1);
      await assertReservationInvariant(driverId);
    });

    it('resolves a confirm-versus-fail race to exactly one outcome', async () => {
      const { finance, driverId, bankAccountId } = await seed();
      const settlementId = await makeSettlement(driverId, 1000);
      const created = await initiate(finance, {
        driverId,
        settlementId,
        bankAccountId,
        amount: 400,
      });
      const id = created.json().data.id as string;

      const [confirmed, failed] = await Promise.all([confirm(finance, id), fail(finance, id)]);

      assertNoServerError([confirmed, failed]);
      assert.deepEqual([confirmed.statusCode, failed.statusCode].sort(), [200, 409]);
      const row = await db().client.driverPayout.findUniqueOrThrow({ where: { id } });
      if (row.status === 'COMPLETED') {
        assert.deepEqual(await wallet(driverId), { balance: 600, locked: 0 });
        assert.equal(await withdrawals(driverId), 1);
      } else {
        assert.equal(row.status, 'FAILED');
        assert.deepEqual(await wallet(driverId), { balance: 1000, locked: 0 });
        assert.equal(await withdrawals(driverId), 0);
      }
      await assertReservationInvariant(driverId);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('failure releases the reservation', () => {
    it('releases the held amount when finance fails the payout', async () => {
      const { finance, driverId, bankAccountId } = await seed();
      const settlementId = await makeSettlement(driverId, 1000);
      const created = await initiate(finance, {
        driverId,
        settlementId,
        bankAccountId,
        amount: 400,
      });
      assert.deepEqual(await wallet(driverId), { balance: 1000, locked: 400 });

      assert.equal((await fail(finance, created.json().data.id)).statusCode, 200);

      assert.deepEqual(await wallet(driverId), { balance: 1000, locked: 0 });
      assert.equal(await withdrawals(driverId), 0);
      await assertReservationInvariant(driverId);
    });

    it('leaves no reservation behind from a rolled-back initiation', async () => {
      const { finance, driverId, bankAccountId } = await seed();
      const settlementId = await makeSettlement(driverId, 1000);
      const key = randomUUID();

      // Three requests share one idempotency key; two lose the unique race and
      // their whole transaction — reservation included — rolls back.
      const results = await Promise.all([
        initiate(finance, { driverId, settlementId, bankAccountId, amount: 250 }, key),
        initiate(finance, { driverId, settlementId, bankAccountId, amount: 250 }, key),
        initiate(finance, { driverId, settlementId, bankAccountId, amount: 250 }, key),
      ]);

      assertNoServerError(results);
      for (const r of results) {
        assert.ok(
          r.statusCode === 200 ||
            (r.statusCode === 409 && r.json().error.code === 'IDEMPOTENCY_IN_PROGRESS'),
          `a same-key request is the winner, a replay, or refused as in-flight: ${r.payload}`,
        );
      }
      assert.equal(await db().client.driverPayout.count({ where: { driverId } }), 1);
      assert.deepEqual(await wallet(driverId), { balance: 1000, locked: 250 });
      await assertReservationInvariant(driverId);
    });

    it('leaves no reservation behind from an initiation refused after validation', async () => {
      const { finance, driverId, bankAccountId } = await seed();
      const settlementId = await makeSettlement(driverId, 1000);

      const refused = await initiate(finance, {
        driverId,
        settlementId,
        bankAccountId,
        amount: 1000.01,
      });

      assert.equal(refused.statusCode, 422, refused.payload);
      assert.deepEqual(await wallet(driverId), { balance: 1000, locked: 0 });
      await assertReservationInvariant(driverId);
    });
  });
});

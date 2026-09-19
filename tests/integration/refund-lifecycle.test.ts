import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { container } from '../../src/core/di.js';
import type { TransactionManager } from '../../src/core/database/TransactionManager.js';
import {
  bootApp,
  bootEventConsumers,
  db,
  drainOutbox,
  loginAs,
  resetState,
  type LoggedInUser,
} from './helpers/harness.js';
import { grantRole, makeDriver, makeSubscriptionPlan } from './helpers/fixtures.js';
import { fundWallet } from './helpers/ride-flow.js';
import { paymentConfig } from '../../src/config/payment/payment.config.js';
import { mockGatewayControl } from '../../src/modules/payments/services/gateway/mock.gateway.js';
import type { RefundService } from '../../src/modules/payments/services/refund/refund.service.js';
import type { WalletService } from '../../src/modules/payments/services/wallet/wallet.service.js';
import { Decimal } from '../../src/modules/payments/types/index.js';

const CUSTOMER = '+919876606001';
const DRIVER = '+919876606002';
const FINANCE = '+919876606003';
const SUPPORT = '+919876606004';

const refunds = () => container.resolve<RefundService>('refundService');
const later = () => new Date(Date.now() + 10 * 60_000);

/// Phase 1 — refunds reverse their OWN original collection, exactly once.
///
///   CUSTOMER_WALLET_TOPUP        refund: CUSTOMER_WALLET DR / GATEWAY_CLEARING CR
///   DRIVER_COMMISSION_RECHARGE   refund: DRIVER_COMMISSION_WALLET DR / GATEWAY_CLEARING CR
///   DRIVER_SUBSCRIPTION_PAYMENT  refund: SUBSCRIPTION_REVENUE DR / GATEWAY_CLEARING CR
///
/// Each passes through REFUND_IN_TRANSIT while the provider is asked, so the
/// net per refund is exactly the rows above, and in between the reserved
/// balance cannot be spent. The provider is addressed by its own payment id.
describe('refund lifecycle (integration, real HTTP)', () => {
  let app: FastifyInstance;
  let stopConsumers: () => void;

  before(async () => {
    app = await bootApp();
    stopConsumers = bootEventConsumers();
  });
  after(async () => {
    stopConsumers();
    await app.close();
  });
  afterEach(async () => {
    mockGatewayControl.reset();
    await resetState();
  });

  async function loginWithRole(phone: string, role: string): Promise<LoggedInUser> {
    const user = await loginAs(app, phone);
    await grantRole(user.userId, role);
    return loginAs(app, phone);
  }

  /// A real, signed Razorpay `payment.captured` delivery for an intent.
  async function capture(gatewayIntentId: string): Promise<void> {
    const body = JSON.stringify({
      event: 'payment.captured',
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        payment: {
          entity: {
            id: `pay_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
            order_id: gatewayIntentId,
            status: 'captured',
          },
        },
      },
    });
    const delivered = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/webhooks/razorpay',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': createHmac(
          'sha256',
          paymentConfig.razorpayWebhookSecret ?? paymentConfig.webhookSecret,
        )
          .update(body)
          .digest('hex'),
        'x-razorpay-event-id': `evt_${randomUUID()}`,
      },
      payload: body,
    });
    assert.equal(delivered.statusCode, 200, delivered.payload);
  }

  async function lastTransaction(userId: string, purpose: string) {
    return db().client.paymentTransaction.findFirstOrThrow({
      where: { userId, intent: { purpose } },
      orderBy: { createdAt: 'desc' },
    });
  }

  function refund(user: LoggedInUser, transactionId: string, amount: number, key = randomUUID()) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/payments/refunds',
      headers: { ...user.authHeader, 'idempotency-key': key },
      payload: { transactionId, amount },
    });
  }

  /// Net per account for one refund's ledger entries: debits positive.
  async function refundLedger(refundId: string): Promise<Record<string, number>> {
    const rows = await db().client.paymentLedgerEntry.findMany({
      where: { referenceType: 'REFUND', referenceId: refundId },
    });
    const net: Record<string, number> = {};
    for (const r of rows) {
      net[r.account] =
        (net[r.account] ?? 0) + (r.direction === 'DEBIT' ? 1 : -1) * Number(r.amount);
    }
    return net;
  }

  async function customerBalance(userId: string): Promise<number> {
    const wallet = await db().client.customerWallet.findUnique({ where: { userId } });
    return Number(wallet?.balance ?? 0);
  }

  async function commissionBalance(driverId: string): Promise<number> {
    const wallet = await db().client.driverCommissionWallet.findUniqueOrThrow({
      where: { driverId },
    });
    return Number(wallet.balance);
  }

  async function rechargeCommission(user: LoggedInUser, amount: number): Promise<void> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/driver-wallet/recharge',
      headers: { ...user.authHeader, 'idempotency-key': randomUUID() },
      payload: { amount },
    });
    assert.equal(response.statusCode, 200, response.payload);
    await capture(response.json().data.gatewayIntentId);
  }

  async function commissionDriver(balance = 0) {
    const user = await loginWithRole(DRIVER, 'driver');
    const driverId = await makeDriver(user.userId, {
      verified: true,
      paymentModel: 'COMMISSION',
      commissionWalletBalance: balance,
    });
    return { user, driverId };
  }

  // ─── customer wallet top-up ──────────────────────────────────────────────
  describe('customer wallet top-up', () => {
    it('refunds the customer’s own top-up, addressed by the provider payment id', async () => {
      const customer = await loginAs(app, CUSTOMER);
      await fundWallet(app, customer, 500);
      const txn = await lastTransaction(customer.userId, 'CUSTOMER_WALLET_TOPUP');

      const response = await refund(customer, txn.id, 200);

      assert.equal(response.statusCode, 200, response.payload);
      assert.equal(response.json().data.status, 'SUCCEEDED');
      assert.equal(await customerBalance(customer.userId), 300);

      const call = mockGatewayControl.createRefundCalls[0];
      assert.equal(call?.providerPaymentId, txn.gatewayTxnId);
      assert.ok(call?.providerPaymentId.startsWith('pay_'), 'the provider’s pay_ id');
      assert.notEqual(call?.providerPaymentId, txn.id, 'never our internal transaction id');

      assert.deepEqual(await refundLedger(response.json().data.id), {
        CUSTOMER_WALLET: 200,
        REFUND_IN_TRANSIT: 0,
        GATEWAY_CLEARING: -200,
      });
    });

    it('refuses to refund top-up money that has already been spent', async () => {
      const customer = await loginAs(app, CUSTOMER);
      await fundWallet(app, customer, 500);
      const txn = await lastTransaction(customer.userId, 'CUSTOMER_WALLET_TOPUP');
      await container.resolve<TransactionManager>('transactionManager').execute((tx) =>
        container
          .resolve<WalletService>('walletService')
          .debitInTx(customer.userId, new Decimal(400), tx, {
            referenceType: 'RIDE',
            referenceId: randomUUID(),
            description: 'spent on a ride',
          }),
      );

      const response = await refund(customer, txn.id, 200);

      assert.equal(response.statusCode, 422, response.payload);
      assert.equal(response.json().error.code, 'REFUND_BALANCE_UNAVAILABLE');
      assert.equal(await db().client.refund.count(), 0, 'nothing is left behind');
      assert.equal(await customerBalance(customer.userId), 100);
      assert.equal(mockGatewayControl.createRefundCalls.length, 0, 'the provider is never asked');
    });

    it('lets support refund on the customer’s behalf — debiting the customer, not the agent', async () => {
      const customer = await loginAs(app, CUSTOMER);
      await fundWallet(app, customer, 500);
      const txn = await lastTransaction(customer.userId, 'CUSTOMER_WALLET_TOPUP');
      const support = await loginWithRole(SUPPORT, 'support');

      const response = await refund(support, txn.id, 100);

      assert.equal(response.statusCode, 200, response.payload);
      assert.equal(await customerBalance(customer.userId), 400);
      assert.equal(await customerBalance(support.userId), 0);
      const row = await db().client.refund.findUniqueOrThrow({
        where: { id: response.json().data.id },
      });
      assert.equal(row.userId, customer.userId, 'the refund belongs to the payer');
    });
  });

  // ─── commission recharge ─────────────────────────────────────────────────
  describe('commission recharge', () => {
    it('never lets the driver self-refund, nor support', async () => {
      const { user } = await commissionDriver();
      await rechargeCommission(user, 500);
      const txn = await lastTransaction(user.userId, 'DRIVER_COMMISSION_RECHARGE');
      const support = await loginWithRole(SUPPORT, 'support');

      assert.equal((await refund(user, txn.id, 500)).statusCode, 422);
      assert.equal((await refund(support, txn.id, 500)).statusCode, 422);
      assert.equal(await db().client.refund.count(), 0);
    });

    it('lets finance refund it, reversing DRIVER_COMMISSION_WALLET exactly once', async () => {
      const { user, driverId } = await commissionDriver(0);
      await rechargeCommission(user, 500);
      assert.equal(await commissionBalance(driverId), 500);
      const txn = await lastTransaction(user.userId, 'DRIVER_COMMISSION_RECHARGE');
      const finance = await loginWithRole(FINANCE, 'finance');
      const key = randomUUID();

      const first = await refund(finance, txn.id, 500, key);
      const replay = await refund(finance, txn.id, 500, key);

      assert.equal(first.statusCode, 200, first.payload);
      assert.equal(first.json().data.status, 'SUCCEEDED');
      assert.equal(replay.json().data.id, first.json().data.id, 'the same refund, replayed');
      assert.equal(await commissionBalance(driverId), 0);
      assert.equal(
        await db().client.driverCommissionWalletTransaction.count({
          where: { driverId, txnType: 'REFUND' },
        }),
        1,
        'the credit is reversed once',
      );
      assert.equal(mockGatewayControl.createRefundCalls.length, 1, 'one provider refund');
      const ledger = await refundLedger(first.json().data.id);
      assert.deepEqual(ledger, {
        DRIVER_COMMISSION_WALLET: 500,
        REFUND_IN_TRANSIT: 0,
        GATEWAY_CLEARING: -500,
      });
      assert.ok(!('CUSTOMER_WALLET' in ledger), 'never posted to CUSTOMER_WALLET');
      assert.equal(await customerBalance(finance.userId), 0, 'no wallet of the staff member moves');
    });

    it('refuses to refund commission credit that has already paid for rides', async () => {
      const { user, driverId } = await commissionDriver(0);
      await rechargeCommission(user, 500);
      await db().client.driverCommissionWallet.update({
        where: { driverId },
        data: { balance: new Decimal(100) },
      });
      const txn = await lastTransaction(user.userId, 'DRIVER_COMMISSION_RECHARGE');
      const finance = await loginWithRole(FINANCE, 'finance');

      const response = await refund(finance, txn.id, 500);

      assert.equal(response.statusCode, 422, response.payload);
      assert.equal(response.json().error.code, 'REFUND_BALANCE_UNAVAILABLE');
      assert.equal(await commissionBalance(driverId), 100);
    });
  });

  // ─── subscription ────────────────────────────────────────────────────────
  describe('subscription payment', () => {
    it('refunds only in full, reverses SUBSCRIPTION_REVENUE, and ends the entitlement', async () => {
      const user = await loginWithRole(DRIVER, 'driver');
      const driverId = await makeDriver(user.userId, {
        verified: true,
        paymentModel: 'SUBSCRIPTION',
      });
      const planId = await makeSubscriptionPlan({ price: 300 });
      const purchased = await app.inject({
        method: 'POST',
        url: '/api/v1/subscriptions',
        headers: { ...user.authHeader, 'idempotency-key': randomUUID() },
        payload: { planId },
      });
      assert.equal(purchased.statusCode, 200, purchased.payload);
      const intent = await db().client.paymentIntent.findUniqueOrThrow({
        where: { id: purchased.json().data.intentId },
      });
      await capture(intent.gatewayIntentId as string);
      await drainOutbox();
      const active = await db().client.driverSubscription.findFirstOrThrow({ where: { driverId } });
      assert.equal(active.status, 'ACTIVE');

      const txn = await lastTransaction(user.userId, 'DRIVER_SUBSCRIPTION_PAYMENT');
      const finance = await loginWithRole(FINANCE, 'finance');

      const partial = await refund(finance, txn.id, 100);
      assert.equal(partial.statusCode, 422, partial.payload);
      assert.match(partial.json().error.message, /in full/);

      const full = await refund(finance, txn.id, 300);
      assert.equal(full.statusCode, 200, full.payload);
      assert.equal(full.json().data.status, 'SUCCEEDED');
      assert.deepEqual(await refundLedger(full.json().data.id), {
        SUBSCRIPTION_REVENUE: 300,
        REFUND_IN_TRANSIT: 0,
        GATEWAY_CLEARING: -300,
      });

      await drainOutbox();
      const ended = await db().client.driverSubscription.findUniqueOrThrow({
        where: { id: active.id },
      });
      assert.equal(ended.status, 'REFUNDED', 'a refunded subscription entitles no new rides');
    });
  });

  // ─── unknown outcomes, failures, concurrency ─────────────────────────────
  describe('provider outcomes', () => {
    it('keeps a timed-out refund PROCESSING with the balance reserved, then reconciles it', async () => {
      const customer = await loginAs(app, CUSTOMER);
      await fundWallet(app, customer, 500);
      const txn = await lastTransaction(customer.userId, 'CUSTOMER_WALLET_TOPUP');
      mockGatewayControl.refundMode = 'TIMEOUT';

      const response = await refund(customer, txn.id, 200);

      assert.equal(response.statusCode, 200, response.payload);
      assert.equal(response.json().data.status, 'PROCESSING', 'never FAILED on a timeout');
      assert.equal(await customerBalance(customer.userId), 300, 'the amount is reserved');

      mockGatewayControl.refundMode = 'SUCCEED';
      const report = await refunds().reconcileStale(later());

      assert.equal(report.resolved, 1);
      const row = await db().client.refund.findUniqueOrThrow({
        where: { id: response.json().data.id },
      });
      assert.equal(row.status, 'SUCCEEDED');
      assert.equal(await customerBalance(customer.userId), 300, 'debited once, not twice');
      assert.equal(mockGatewayControl.refunds.size, 1);
    });

    it('recovers a refund the provider made but whose response was lost — without a second refund', async () => {
      const customer = await loginAs(app, CUSTOMER);
      await fundWallet(app, customer, 500);
      const txn = await lastTransaction(customer.userId, 'CUSTOMER_WALLET_TOPUP');
      mockGatewayControl.refundMode = 'CREATE_THEN_TIMEOUT';

      const response = await refund(customer, txn.id, 200);
      assert.equal(response.json().data.status, 'PROCESSING');
      assert.equal(mockGatewayControl.refunds.size, 1, 'the provider did refund');

      mockGatewayControl.refundMode = 'SUCCEED';
      await refunds().reconcileStale(later());

      const row = await db().client.refund.findUniqueOrThrow({
        where: { id: response.json().data.id },
      });
      assert.equal(row.status, 'SUCCEEDED');
      assert.equal(
        mockGatewayControl.createRefundCalls.length,
        1,
        'found by reference, not re-created',
      );
    });

    it('undoes the reservation exactly when the provider refuses, and keeps the record', async () => {
      const customer = await loginAs(app, CUSTOMER);
      await fundWallet(app, customer, 500);
      const txn = await lastTransaction(customer.userId, 'CUSTOMER_WALLET_TOPUP');
      mockGatewayControl.refundMode = 'REJECT';

      const response = await refund(customer, txn.id, 200);

      assert.equal(response.statusCode, 200, response.payload);
      assert.equal(response.json().data.status, 'FAILED');
      assert.equal(await customerBalance(customer.userId), 500, 'the balance is restored');
      const row = await db().client.refund.findUniqueOrThrow({
        where: { id: response.json().data.id },
      });
      assert.ok(row.failureReason, 'the failure is recorded');
      const ledger = await refundLedger(row.id);
      assert.equal(ledger.CUSTOMER_WALLET, 0);
      assert.equal(ledger.REFUND_IN_TRANSIT, 0);
      assert.equal(ledger.GATEWAY_CLEARING, undefined, 'nothing reached the gateway account');
    });

    it('asks the provider once when reconciliation runs concurrently', async () => {
      const customer = await loginAs(app, CUSTOMER);
      await fundWallet(app, customer, 500);
      const txn = await lastTransaction(customer.userId, 'CUSTOMER_WALLET_TOPUP');
      mockGatewayControl.refundMode = 'TIMEOUT';
      const response = await refund(customer, txn.id, 200);
      mockGatewayControl.refundMode = 'SUCCEED';

      const now = later();
      await Promise.all([refunds().reconcileStale(now), refunds().reconcileStale(now)]);

      assert.equal(mockGatewayControl.createRefundCalls.length, 2, 'the timed-out call plus one');
      assert.equal(mockGatewayControl.refunds.size, 1);
      const row = await db().client.refund.findUniqueOrThrow({
        where: { id: response.json().data.id },
      });
      assert.equal(row.status, 'SUCCEEDED');
    });
  });

  // ─── admin finance workflow ──────────────────────────────────────────────
  describe('admin finance workflow', () => {
    it('completes a refund only after the provider confirms it', async () => {
      const customer = await loginAs(app, CUSTOMER);
      await fundWallet(app, customer, 500);
      const txn = await lastTransaction(customer.userId, 'CUSTOMER_WALLET_TOPUP');
      const finance = await loginWithRole(FINANCE, 'finance');
      const post = (url: string, payload: Record<string, unknown> = {}) =>
        app.inject({ method: 'POST', url, headers: finance.authHeader, payload });

      const created = await post('/api/v1/admin/finance/refunds', {
        transactionId: txn.id,
        refundType: 'DOUBLE_PAYMENT',
        requestedAmount: 100,
        reason: 'Charged twice',
      });
      assert.equal(created.statusCode, 201, created.payload);
      const id = created.json().data.id as string;
      assert.equal(
        (await post(`/api/v1/admin/finance/refunds/${id}/approve`, { approvedAmount: 100 }))
          .statusCode,
        200,
      );

      mockGatewayControl.refundMode = 'TIMEOUT';
      assert.equal(
        (await post(`/api/v1/admin/finance/refunds/${id}/mark-processing`)).statusCode,
        200,
      );
      assert.equal(
        (await db().client.refund.findUniqueOrThrow({ where: { id } })).status,
        'PROCESSING',
      );

      const early = await post(`/api/v1/admin/finance/refunds/${id}/mark-completed`);
      assert.equal(early.statusCode, 409, 'not completed on an unknown outcome');
      const reject = await post(`/api/v1/admin/finance/refunds/${id}/reject`, {
        reason: 'changed mind',
      });
      assert.equal(reject.statusCode, 409, 'a reserved refund cannot be rejected');

      mockGatewayControl.refundMode = 'SUCCEED';
      await refunds().reconcileStale(later());
      const done = await post(`/api/v1/admin/finance/refunds/${id}/mark-completed`);
      assert.equal(done.statusCode, 200, done.payload);
      assert.equal(await customerBalance(customer.userId), 400);
    });
  });
});

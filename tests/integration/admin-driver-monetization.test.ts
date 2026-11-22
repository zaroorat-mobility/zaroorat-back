import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import {
  grantRole,
  makeActiveSubscription,
  makeDriver,
  makePendingIntent,
  makeSubscriptionPlan,
} from './helpers/fixtures.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';
import { container } from '../../src/core/di.js';
import { Decimal } from '../../src/modules/payments/types/index.js';
import type { CommissionWalletService } from '../../src/modules/payments/services/commission-wallet/commission-wallet.service.js';

const ADMIN_PHONE = '+919876545111';
const ADMIN_EMAIL = 'monetization-admin@zaroorat.test';
const ADMIN_PASSWORD = 'Admin@12345';

/// Read-only admin views of commission wallets and driver subscriptions, built from the same
/// rows the money paths write (no separate store, nothing written by these routes).
describe('admin driver monetization views (integration)', () => {
  let app: FastifyInstance;
  let admin: { userId: string; headers: { authorization: string } };

  before(async () => {
    app = await bootApp();
  });
  after(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetState();
    const seed = await loginAs(app, ADMIN_PHONE);
    await grantRole(seed.userId, 'system_admin');
    await db().client.user.update({
      where: { id: seed.userId },
      data: {
        email: ADMIN_EMAIL,
        passwordHash: hashPassword(ADMIN_PASSWORD),
        isEmailVerified: true,
      },
    });
    const loggedIn = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/admin/login',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    assert.equal(loggedIn.statusCode, 200, loggedIn.payload);
    admin = {
      userId: seed.userId,
      headers: { authorization: `Bearer ${loggedIn.json().accessToken as string}` },
    };
  });
  afterEach(async () => {
    await resetState();
  });

  const get = (url: string, headers = admin.headers) => app.inject({ method: 'GET', url, headers });

  it('lists wallets with balances and totals from real recharge and admin-credit paths', async () => {
    const user = await loginAs(app, '+919876545112');
    const driverId = await makeDriver(user.userId, {
      paymentModel: 'COMMISSION',
      commissionWalletBalance: 0,
    });
    // A gateway-confirmed recharge, through the service the webhook path uses.
    await db().transactionManager.execute((tx) =>
      container
        .resolve<CommissionWalletService>('commissionWalletService')
        .creditInTx(driverId, new Decimal(300), tx, { referenceType: 'TEST_RECHARGE' }),
    );
    const credited = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/drivers/${driverId}/wallet/topup`,
      headers: admin.headers,
      payload: { amount: 25, notes: 'Goodwill credit for a test' },
    });
    assert.equal(credited.statusCode, 200, credited.payload);

    const res = await get('/api/v1/admin/finance/commission-wallets');
    assert.equal(res.statusCode, 200, res.payload);
    const row = res.json().data.find((w: { driverId: string }) => w.driverId === driverId);
    assert.ok(row, 'wallet listed');
    assert.equal(row.balance, 325);
    assert.equal(row.paymentModel, 'COMMISSION');
    assert.deepEqual(row.totals, {
      recharged: 300,
      commissionDeducted: 0,
      refunded: 0,
      adminCredited: 25,
    });
    assert.equal(row.canCoverCommission, true);

    const txns = await get(`/api/v1/admin/finance/commission-wallets/${driverId}/transactions`);
    assert.equal(txns.statusCode, 200, txns.payload);
    assert.deepEqual(
      txns
        .json()
        .data.map((t: { txnType: string }) => t.txnType)
        .sort(),
      ['ADMIN_CREDIT', 'MANUAL_RECHARGE'],
    );
    const adminTxn = txns
      .json()
      .data.find((t: { txnType: string }) => t.txnType === 'ADMIN_CREDIT');
    assert.equal(adminTxn.description, 'Goodwill credit for a test');

    // Driver Details carries the app account a push message is addressed to.
    const details = await get(`/api/v1/admin/drivers/${driverId}`);
    assert.equal(details.statusCode, 200, details.payload);
    assert.equal(details.json().data.userId, user.userId);

    // Read-only: listing changed nothing.
    const wallet = await db().client.driverCommissionWallet.findUniqueOrThrow({
      where: { driverId },
    });
    assert.equal(Number(wallet.balance), 325);
  });

  it('marks a zero balance as covering no commission ride, and searches by driver code', async () => {
    const user = await loginAs(app, '+919876545113');
    const driverId = await makeDriver(user.userId, {
      paymentModel: 'COMMISSION',
      commissionWalletBalance: 0,
    });
    const driver = await db().client.driver.findUniqueOrThrow({ where: { id: driverId } });

    const res = await get(`/api/v1/admin/finance/commission-wallets?search=${driver.driverCode}`);
    assert.equal(res.statusCode, 200, res.payload);
    assert.equal(res.json().data.length, 1);
    assert.equal(res.json().data[0].canCoverCommission, false);
    assert.equal(res.json().meta.totalCount, 1);
  });

  it('shows what a subscriber paid even after the plan price changes, and counts active subscribers', async () => {
    const user = await loginAs(app, '+919876545114');
    const driverId = await makeDriver(user.userId, { paymentModel: null });
    const planId = await makeSubscriptionPlan({ billingPeriod: 'WEEKLY', price: 499 });
    const subscriptionId = await makeActiveSubscription(driverId, { planId });
    const intentId = await makePendingIntent(user.userId, 499);
    await db().client.driverSubscription.update({
      where: { id: subscriptionId },
      data: { paymentIntentId: intentId },
    });
    // The plan's price is edited afterwards (only possible directly in the database today).
    await db().client.subscriptionPlan.update({ where: { id: planId }, data: { price: 599 } });

    const subs = await get('/api/v1/admin/finance/driver-subscriptions?status=ACTIVE');
    assert.equal(subs.statusCode, 200, subs.payload);
    const row = subs.json().data.find((s: { id: string }) => s.id === subscriptionId);
    assert.ok(row);
    assert.equal(row.paidAmount, 499);
    assert.equal(row.currentPlanPrice, 599);
    assert.equal(row.status, 'ACTIVE');
    assert.equal(row.paymentIntentId, intentId);

    const plans = await get('/api/v1/admin/finance/subscription-plans');
    assert.equal(plans.statusCode, 200, plans.payload);
    const plan = plans.json().data.find((p: { id: string }) => p.id === planId);
    assert.equal(plan.activeSubscribers, 1);
    assert.equal(plan.price, 599);
  });

  it('refuses every route without finance:read', async () => {
    const rider = await loginAs(app, '+919876545115');
    for (const url of [
      '/api/v1/admin/finance/commission-wallets',
      '/api/v1/admin/finance/subscription-plans',
      '/api/v1/admin/finance/driver-subscriptions',
      `/api/v1/admin/finance/commission-wallets/${rider.userId}/transactions`,
    ]) {
      const res = await get(url, rider.authHeader);
      assert.equal(res.statusCode, 403, `${url}: ${res.payload}`);
    }
  });

  it('rejects a malformed driver id and status filter', async () => {
    assert.equal(
      (await get('/api/v1/admin/finance/commission-wallets/not-a-uuid/transactions')).statusCode,
      400,
    );
    assert.equal(
      (await get('/api/v1/admin/finance/driver-subscriptions?status=PAID')).statusCode,
      400,
    );
  });
});

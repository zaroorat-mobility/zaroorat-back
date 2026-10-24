import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState, type LoggedInUser } from './helpers/harness.js';
import { grantRole, makeDriver, makeSubscriptionPlan } from './helpers/fixtures.js';
import { PAYMENT_FEATURE_FLAG_KEYS } from '../../src/modules/admin/system-settings/platform/constants/payment-feature-flags.constants.js';

const DRIVER_A = '+919876605101';
const DRIVER_B = '+919876605102';

/// 005-razorpay-driver-payments, against the real API and database:
/// - T035 (TM-14): per-purpose kill switches; a refusal writes no payment row;
///   an intent created while a switch was on can still be confirmed.
/// - T027 (TM-16): confirm answers someone else's intent exactly like a missing
///   one, and rejects a non-UUID id.
/// - T017 (TM-04): two drivers sending the same Idempotency-Key get two intents.
describe('payment kill switches, confirm ownership, scoped keys (integration)', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await bootApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(async () => {
    // resetState() switches both payment flags back on (harness.ts).
    await resetState();
  });

  async function commissionDriver(phone: string): Promise<LoggedInUser & { driverId: string }> {
    const user = await loginAs(app, phone);
    await grantRole(user.userId, 'driver');
    const driverId = await makeDriver(user.userId, { verified: true, paymentModel: 'COMMISSION' });
    return { ...(await loginAs(app, phone)), driverId };
  }

  async function setFlag(key: string, status: 'ON' | 'OFF') {
    await db().client.featureFlag.upsert({
      where: { key },
      update: { status },
      create: { key, name: key, status, rolloutPercentage: 100, isActive: true },
    });
  }

  const commissionBalance = async (driverId: string) =>
    (
      await db().client.driverCommissionWallet.findUnique({ where: { driverId } })
    )?.balance.toNumber() ?? 0;

  const recharge = (user: LoggedInUser, key = randomUUID()) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/payments/driver-wallet/recharge',
      headers: { ...user.authHeader, 'idempotency-key': key },
      payload: { amount: 500 },
    });

  const confirm = (user: LoggedInUser, intentId: string) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/payments/intents/${intentId}/confirm`,
      headers: { ...user.authHeader, 'idempotency-key': randomUUID() },
    });

  async function unbalancedLedgerGroups(): Promise<number> {
    const rows = await db().client.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM (
        SELECT entry_group FROM payment_ledger_entries GROUP BY entry_group
        HAVING SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END) <> 0
      ) unbalanced`;
    return Number(rows[0]?.n ?? 0);
  }

  it('refuses a recharge with 503 and writes no payment row while its switch is off', async () => {
    const driver = await commissionDriver(DRIVER_A);
    await setFlag(PAYMENT_FEATURE_FLAG_KEYS.DRIVER_CHECKOUT, 'OFF');

    const res = await recharge(driver);

    assert.equal(res.statusCode, 503, res.payload);
    assert.equal(res.json().error.code, 'PAYMENTS_UNAVAILABLE');
    assert.equal(await db().client.paymentIntent.count({ where: { userId: driver.userId } }), 0);
    assert.equal(
      await db().client.paymentTransaction.count({ where: { userId: driver.userId } }),
      0,
    );
  });

  it('refuses a first subscription purchase with 503 and writes no subscription or intent', async () => {
    const user = await loginAs(app, DRIVER_A);
    await grantRole(user.userId, 'driver');
    const driverId = await makeDriver(user.userId, { verified: true, paymentModel: null });
    const driver = await loginAs(app, DRIVER_A);
    const planId = await makeSubscriptionPlan({ billingPeriod: 'WEEKLY', price: 500 });
    await setFlag(PAYMENT_FEATURE_FLAG_KEYS.SUBSCRIPTION_CHECKOUT, 'OFF');

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/subscriptions',
      headers: { ...driver.authHeader, 'idempotency-key': randomUUID() },
      payload: { planId },
    });

    assert.equal(res.statusCode, 503, res.payload);
    assert.equal(res.json().error.code, 'PAYMENTS_UNAVAILABLE');
    assert.equal(await db().client.driverSubscription.count({ where: { driverId } }), 0);
    assert.equal(await db().client.paymentIntent.count({ where: { userId: driver.userId } }), 0);
  });

  it('keeps the switches independent: recharge on, subscription off', async () => {
    const driver = await commissionDriver(DRIVER_A);
    await setFlag(PAYMENT_FEATURE_FLAG_KEYS.SUBSCRIPTION_CHECKOUT, 'OFF');

    const res = await recharge(driver);

    assert.equal(res.statusCode, 200, res.payload);
  });

  it('still confirms an intent created before its switch was turned off, with a balanced ledger', async () => {
    const driver = await commissionDriver(DRIVER_A);
    const created = await recharge(driver);
    assert.equal(created.statusCode, 200, created.payload);
    const intentId = created.json().data.intentId as string;
    await setFlag(PAYMENT_FEATURE_FLAG_KEYS.DRIVER_CHECKOUT, 'OFF');
    const before = await commissionBalance(driver.driverId);

    const res = await confirm(driver, intentId);

    assert.equal(res.statusCode, 200, res.payload);
    assert.equal(res.json().data.status, 'SUCCEEDED');
    assert.equal(await commissionBalance(driver.driverId), before + 500);
    assert.equal(await unbalancedLedgerGroups(), 0, 'every ledger group must balance');
  });

  it("answers another driver's intent exactly like a missing one", async () => {
    const owner = await commissionDriver(DRIVER_A);
    const stranger = await commissionDriver(DRIVER_B);
    const created = await recharge(owner);
    const intentId = created.json().data.intentId as string;

    const foreign = await confirm(stranger, intentId);
    const missing = await confirm(stranger, randomUUID());

    assert.equal(foreign.statusCode, 404, foreign.payload);
    assert.equal(missing.statusCode, 404, missing.payload);
    const strip = (body: { error: Record<string, unknown> }) => {
      const { requestId: _r, message: _m, ...rest } = body.error;
      return rest;
    };
    assert.deepEqual(strip(foreign.json()), strip(missing.json()));
    assert.equal(
      await db().client.paymentIntent.count({ where: { id: intentId, status: 'PENDING' } }),
      1,
      'the stranger changed nothing',
    );
  });

  it('rejects a non-UUID intent id with 400', async () => {
    const driver = await commissionDriver(DRIVER_A);

    const res = await confirm(driver, 'not-a-uuid');

    assert.equal(res.statusCode, 400, res.payload);
  });

  it('gives two drivers who send the same key two separate intents', async () => {
    const a = await commissionDriver(DRIVER_A);
    const b = await commissionDriver(DRIVER_B);
    const key = randomUUID();

    const first = await recharge(a, key);
    const second = await recharge(b, key);

    assert.equal(first.statusCode, 200, first.payload);
    assert.equal(second.statusCode, 200, second.payload);
    assert.notEqual(first.json().data.intentId, second.json().data.intentId);
    const keys = (
      await db().client.paymentIntent.findMany({
        where: { userId: { in: [a.userId, b.userId] } },
        select: { idempotencyKey: true },
      })
    )
      .map((r) => r.idempotencyKey)
      .sort();
    assert.deepEqual(
      keys,
      [`recharge:${a.driverId}:${key}`, `recharge:${b.driverId}:${key}`].sort(),
    );
  });
});

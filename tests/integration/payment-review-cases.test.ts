import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { grantRole, makeDriver, makeSubscriptionPlan } from './helpers/fixtures.js';
import { paymentConfig } from '../../src/config/payment/payment.config.js';
import { container } from '../../src/core/di.js';
import type { PaymentReviewCaseRepository } from '../../src/modules/payments/repositories/payment-review-case.repository.js';

const WEBHOOK = '/api/v1/payments/webhooks/razorpay';
const SUCCESS_EVENTS = ['payment.succeeded', 'driver.subscription.payment.completed'];

/// 005-razorpay-driver-payments T022 (TM-06), against the real API and a
/// database carrying migration 20261021120000. A captured payment the
/// validation gate cannot apply is held: one review case, one CAPTURED_REVIEW
/// row, the intent in MANUAL_REVIEW, and no wallet, subscription or ledger
/// effect. UD-2 is open, so no suspense ledger group is posted and the case
/// records that gap.
describe('payment review cases (integration)', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await bootApp();
    // Also switches both payment flags on (harness.ts).
    await resetState();
  });
  after(async () => {
    await app.close();
  });
  afterEach(async () => {
    await resetState();
  });

  const payId = () => `pay_${randomUUID().replace(/-/g, '').slice(0, 14)}`;

  async function deliver(
    event: string,
    entity: Record<string, unknown>,
    options: { eventId?: string; order?: Record<string, unknown> } = {},
  ) {
    const body = JSON.stringify({
      event,
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        payment: { entity },
        ...(options.order ? { order: { entity: options.order } } : {}),
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: WEBHOOK,
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': createHmac(
          'sha256',
          paymentConfig.razorpayWebhookSecret ?? paymentConfig.webhookSecret,
        )
          .update(body)
          .digest('hex'),
        'x-razorpay-event-id': options.eventId ?? `evt_${randomUUID()}`,
      },
      payload: body,
    });
    assert.equal(res.statusCode, 200, res.payload);
    return res.json();
  }

  async function rechargeIntent(phone: string) {
    const user = await loginAs(app, phone);
    await grantRole(user.userId, 'driver');
    const driverId = await makeDriver(user.userId, { verified: true, paymentModel: 'COMMISSION' });
    const driver = await loginAs(app, phone);
    const initialBalance = await balance(driverId);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/driver-wallet/recharge',
      headers: { ...driver.authHeader, 'idempotency-key': randomUUID() },
      payload: { amount: 500 },
    });
    assert.equal(res.statusCode, 200, res.payload);
    const intent = await db().client.paymentIntent.findFirstOrThrow({
      where: { gatewayIntentId: res.json().data.gatewayIntentId },
    });
    return { driverId, intentId: intent.id, orderId: intent.gatewayIntentId!, initialBalance };
  }

  async function subscriptionIntent(phone: string) {
    const user = await loginAs(app, phone);
    await grantRole(user.userId, 'driver');
    const driverId = await makeDriver(user.userId, { verified: true, paymentModel: null });
    const driver = await loginAs(app, phone);
    const initialBalance = await balance(driverId);
    const planId = await makeSubscriptionPlan({ billingPeriod: 'WEEKLY', price: 500 });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/subscriptions',
      headers: { ...driver.authHeader, 'idempotency-key': randomUUID() },
      payload: { planId },
    });
    assert.equal(res.statusCode, 200, res.payload);
    const intent = await db().client.paymentIntent.findUniqueOrThrow({
      where: { id: res.json().data.intentId },
    });
    return { driverId, intentId: intent.id, orderId: intent.gatewayIntentId!, initialBalance };
  }

  const captured = (orderId: string, id = payId(), amount = 50000) => ({
    id,
    order_id: orderId,
    amount,
    currency: 'INR',
    status: 'captured',
  });

  /// makeDriver funds a commission wallet, so every check is relative.
  const balance = async (driverId: string) =>
    (
      await db().client.driverCommissionWallet.findUnique({ where: { driverId } })
    )?.balance.toNumber() ?? 0;

  async function heldRows(intentId: string) {
    return db().client.paymentTransaction.findMany({
      where: { intentId, status: 'CAPTURED_REVIEW' },
    });
  }

  async function assertNoMoneyMoved(intentId: string) {
    assert.equal(
      await db().client.paymentLedgerEntry.count({ where: { referenceId: intentId } }),
      0,
      'no ledger group while UD-2 is open',
    );
    assert.equal(
      await db().client.outboxEvent.count({ where: { eventType: { in: SUCCESS_EVENTS } } }),
      0,
      'no success or activation event',
    );
    assert.equal(
      await db().client.paymentTransaction.count({ where: { intentId, status: 'SUCCEEDED' } }),
      0,
    );
  }

  for (const [purpose, make] of [
    ['recharge', rechargeIntent],
    ['subscription', subscriptionIntent],
  ] as const) {
    it(`holds a ${purpose} capture one paisa short: one case, one hold row, no money moved`, async () => {
      const { driverId, intentId, orderId, initialBalance } = await make('+919876606101');
      const payment = captured(orderId, payId(), 49999);

      await deliver('payment.captured', payment);

      const intent = await db().client.paymentIntent.findUniqueOrThrow({ where: { id: intentId } });
      assert.equal(intent.status, 'MANUAL_REVIEW');
      const held = await heldRows(intentId);
      assert.equal(held.length, 1);
      assert.equal(held[0]!.gatewayTxnId, payment.id);
      assert.equal(held[0]!.amount.toFixed(2), '499.99', 'the provider-reported amount');

      const cases = await db().client.paymentReviewCase.findMany();
      assert.equal(cases.length, 1);
      assert.equal(cases[0]!.kind, 'AMOUNT_MISMATCH');
      assert.equal(cases[0]!.status, 'OPEN');
      assert.equal(cases[0]!.intentId, intentId);
      assert.equal(cases[0]!.paymentTransactionId, held[0]!.id);
      assert.equal(cases[0]!.expectedAmount?.toFixed(2), '500.00');
      assert.equal(cases[0]!.observedAmount.toFixed(2), '499.99');
      const evidence = cases[0]!.evidence as Record<string, unknown>;
      assert.equal(evidence.ledger, 'NOT_POSTED_UD2_OPEN', 'the case reports the ledger gap');
      for (const pii of ['email', 'contact', 'vpa', 'card']) assert.ok(!(pii in evidence));

      await assertNoMoneyMoved(intentId);
      assert.equal(await balance(driverId), initialBalance, 'no wallet credit');
      assert.equal(
        await db().client.driverSubscription.count({ where: { driverId, status: 'ACTIVE' } }),
        0,
      );
    });
  }

  it('keeps one case and one hold row across a redelivery and an order.paid for the same payment', async () => {
    const { intentId, orderId } = await rechargeIntent('+919876606102');
    const payment = captured(orderId, payId(), 49999);
    const eventId = `evt_${randomUUID()}`;

    await deliver('payment.captured', payment, { eventId });
    const again = await deliver('payment.captured', payment, { eventId });
    assert.equal(again.isDuplicate, true);
    await deliver('order.paid', payment, { order: { amount: 50000, amount_paid: 49999 } });

    assert.equal(await db().client.paymentReviewCase.count(), 1);
    assert.equal((await heldRows(intentId)).length, 1);
    await assertNoMoneyMoved(intentId);
  });

  it('opens PAYMENT_ID_REUSED without a hold row and leaves a SUCCEEDED intent SUCCEEDED (A6)', async () => {
    const a = await rechargeIntent('+919876606103');
    const b = await rechargeIntent('+919876606104');
    const reused = payId();
    await deliver('payment.captured', captured(a.orderId, reused));
    await deliver('payment.captured', captured(b.orderId));
    assert.equal(await balance(a.driverId), a.initialBalance + 500);
    assert.equal(await balance(b.driverId), b.initialBalance + 500);

    // B's order reports A's payment id.
    await deliver('payment.captured', captured(b.orderId, reused));

    const cases = await db().client.paymentReviewCase.findMany();
    assert.equal(cases.length, 1);
    assert.equal(cases[0]!.kind, 'PAYMENT_ID_REUSED');
    const appliedOnA = await db().client.paymentTransaction.findFirstOrThrow({
      where: { intentId: a.intentId, status: 'SUCCEEDED' },
    });
    assert.equal(cases[0]!.paymentTransactionId, appliedOnA.id);
    assert.equal(
      await db().client.paymentTransaction.count({ where: { status: 'CAPTURED_REVIEW' } }),
      0,
    );
    const intentB = await db().client.paymentIntent.findUniqueOrThrow({
      where: { id: b.intentId },
    });
    assert.equal(intentB.status, 'SUCCEEDED');
    assert.equal(await balance(b.driverId), b.initialBalance + 500, 'no second credit');
  });

  it('holds an order.paid whose amount_paid differs from the expected paise, with no credit', async () => {
    const { driverId, intentId, orderId, initialBalance } = await rechargeIntent('+919876606105');

    await deliver('order.paid', captured(orderId), {
      order: { amount: 50000, amount_paid: 49900, currency: 'INR' },
    });

    const cases = await db().client.paymentReviewCase.findMany();
    assert.equal(cases.length, 1);
    assert.equal(cases[0]!.kind, 'AMOUNT_MISMATCH');
    assert.equal((cases[0]!.evidence as Record<string, unknown>).order_amount_paid, 49900);
    assert.equal(await balance(driverId), initialBalance);
    await assertNoMoneyMoved(intentId);
  });

  for (const [label, entity] of [
    ['a missing amount', { amount: undefined }],
    ['an amount sent as a string', { amount: '50000' }],
    ['a missing currency', { currency: undefined }],
  ] as const) {
    it(`applies nothing and opens no case for ${label}`, async () => {
      const { driverId, intentId, orderId, initialBalance } = await rechargeIntent('+919876606106');

      await deliver('payment.captured', { ...captured(orderId), ...entity });

      const intent = await db().client.paymentIntent.findUniqueOrThrow({ where: { id: intentId } });
      assert.equal(intent.status, 'PENDING', 'left for reconciliation');
      assert.equal(await db().client.paymentReviewCase.count(), 0);
      assert.equal(await balance(driverId), initialBalance);
      await assertNoMoneyMoved(intentId);
    });
  }

  it('never lets a payload claim an intent by its own id as the order (decision R1)', async () => {
    const { driverId, intentId, initialBalance } = await rechargeIntent('+919876606108');

    // Our intent's UUID where Razorpay's order id belongs: formerly matched by
    // a fallback, now no intent owns that "order".
    await deliver('payment.captured', captured(intentId));

    const intent = await db().client.paymentIntent.findUniqueOrThrow({ where: { id: intentId } });
    assert.equal(intent.status, 'PENDING', 'the claimed intent is untouched');
    assert.equal(await balance(driverId), initialBalance);
    const cases = await db().client.paymentReviewCase.findMany();
    assert.equal(cases.length, 1);
    assert.equal(cases[0]!.kind, 'UNKNOWN_ORDER');
    assert.equal(cases[0]!.intentId, null);
  });

  it('opens UNKNOWN_ORDER, with no intent, for a capture on an order we did not create (A9)', async () => {
    await deliver('payment.captured', captured('order_NOT_OURS_1'));

    const cases = await db().client.paymentReviewCase.findMany();
    assert.equal(cases.length, 1);
    assert.equal(cases[0]!.kind, 'UNKNOWN_ORDER');
    assert.equal(cases[0]!.intentId, null);
    assert.equal(cases[0]!.paymentTransactionId, null);
  });

  it('resolves a case once: a second claim loses, and a resolution needs its fields', async () => {
    const { orderId } = await rechargeIntent('+919876606107');
    await deliver('payment.captured', captured(orderId, payId(), 49999));
    const repo = container.resolve<PaymentReviewCaseRepository>('paymentReviewCaseRepository');
    const [open] = await repo.listOpen();
    assert.ok(open);

    const resolution = {
      status: 'RESOLVED_REFUND' as const,
      resolvedBy: 'finance-test',
      resolutionNote: 'refund in full',
    };
    assert.equal(await repo.claimResolution(open.id, resolution), true);
    assert.equal(await repo.claimResolution(open.id, resolution), false);
    assert.equal((await repo.findById(open.id))?.status, 'RESOLVED_REFUND');
    assert.deepEqual(await repo.listOpen(), []);

    await assert.rejects(
      db().client.paymentReviewCase.update({
        where: { id: open.id },
        data: { status: 'RESOLVED_CREDIT', resolutionNote: null },
      }),
      /payment_review_cases_resolution_check/,
    );
  });
});

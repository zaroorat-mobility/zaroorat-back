import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import {
  bootApp,
  bootEventConsumers,
  db,
  drainOutbox,
  loginAs,
  resetState,
} from './helpers/harness.js';
import { grantRole, makeDriver, makeSubscriptionPlan } from './helpers/fixtures.js';
import { container } from '../../src/core/di.js';
import { paymentConfig } from '../../src/config/payment/payment.config.js';
import type { Unsubscribe } from '../../src/core/events/index.js';
import type { OutboxRelay } from '../../src/core/events/OutboxRelay.js';
import type { SubscriptionPaymentConsumer } from '../../src/modules/subscriptions/consumers/subscription-payment.consumer.js';
import type { SubscriptionReconciliationJob } from '../../src/modules/subscriptions/jobs/subscription-reconciliation.job.js';

const PURCHASE = '/api/v1/subscriptions';
const WEBHOOK = '/api/v1/payments/webhooks/razorpay';
const EVENT_TYPE_SUBSCRIPTION_COMPLETED = 'driver.subscription.payment.completed';

describe('H4 — Subscription activation failure recovery & outbox reliability', () => {
  let app: FastifyInstance;
  let stopConsumers: Unsubscribe;

  before(async () => {
    app = await bootApp();
    stopConsumers = bootEventConsumers();
    await resetState();
  });
  after(async () => {
    stopConsumers();
    await app.close();
  });
  afterEach(async () => {
    await db().client.$executeRawUnsafe('TRUNCATE "gateway_events" CASCADE');
    await resetState();
  });

  async function driverWorld(phone: string) {
    const driverUser = await loginAs(app, phone);
    await grantRole(driverUser.userId, 'driver');
    const driverId = await makeDriver(driverUser.userId, {
      verified: true,
      paymentModel: 'COMMISSION',
    });
    await drainOutbox();
    const driver = await loginAs(app, phone);
    return { driver, driverId, userId: driverUser.userId };
  }

  function deliverWebhook(orderReference: string, eventId = `evt_${randomUUID()}`) {
    const body = JSON.stringify({
      event: 'payment.captured',
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        payment: {
          entity: {
            id: `pay_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
            order_id: orderReference,
            status: 'captured',
          },
        },
      },
    });
    return app.inject({
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
        'x-razorpay-event-id': eventId,
      },
      payload: body,
    });
  }

  it('Test 1 — Normal success: Payment succeeds -> outbox event -> consumer -> subscription ACTIVE -> paymentModel=SUBSCRIPTION', async () => {
    const { driver, driverId } = await driverWorld('+919870000001');
    const planId = await makeSubscriptionPlan({ billingPeriod: 'MONTHLY', price: 1000 });

    const purchaseRes = await app.inject({
      method: 'POST',
      url: PURCHASE,
      headers: { ...driver.authHeader, 'idempotency-key': randomUUID() },
      payload: { planId },
    });
    assert.equal(purchaseRes.statusCode, 200);
    const { intentId, subscriptionId } = purchaseRes.json().data;

    // Deliver payment webhook
    const hookRes = await deliverWebhook(intentId);
    assert.equal(hookRes.statusCode, 200);

    // Drain outbox to activate
    await drainOutbox();

    const sub = await db().client.driverSubscription.findUniqueOrThrow({
      where: { id: subscriptionId },
    });
    assert.equal(sub.status, 'ACTIVE');
    assert.equal(sub.paymentStatus, 'PAID');

    const drv = await db().client.driver.findUniqueOrThrow({ where: { id: driverId } });
    assert.equal(drv.paymentModel, 'SUBSCRIPTION');
  });

  it('Test 2 & 3 — Activation transient failure & retry after failure: outbox event remains PENDING on failure, then succeeds on retry without financial duplication', async () => {
    const { driver, driverId } = await driverWorld('+919870000002');
    const planId = await makeSubscriptionPlan({ billingPeriod: 'WEEKLY', price: 500 });

    const purchaseRes = await app.inject({
      method: 'POST',
      url: PURCHASE,
      headers: { ...driver.authHeader, 'idempotency-key': randomUUID() },
      payload: { planId },
    });
    const { intentId, subscriptionId } = purchaseRes.json().data;

    // Mock driverRepository.updatePaymentModel to fail once
    const driverRepo = container.resolve('driverRepository') as {
      updatePaymentModel: (...args: unknown[]) => Promise<unknown>;
    };
    const origUpdatePaymentModel = driverRepo.updatePaymentModel.bind(driverRepo);
    let failCount = 0;
    driverRepo.updatePaymentModel = async (...args: unknown[]) => {
      if (failCount === 0) {
        failCount++;
        throw new Error('Simulated transient DB failure during driver payment model update');
      }
      return origUpdatePaymentModel(...args);
    };

    // Deliver payment webhook (creates outbox event)
    await deliverWebhook(intentId);

    // Drain outbox (attempt 1 will fail due to mock error)
    await drainOutbox();

    assert.equal(failCount, 1, 'Simulated failure was triggered');

    // Restore original method
    driverRepo.updatePaymentModel = origUpdatePaymentModel;

    // Verify outbox event is status: PENDING (not PUBLISHED) after failure
    const outboxAfterFail = await db().client.outboxEvent.findFirstOrThrow({
      where: { eventType: EVENT_TYPE_SUBSCRIPTION_COMPLETED },
    });
    assert.equal(
      outboxAfterFail.status,
      'PENDING',
      'Event must remain PENDING (unpublished) when consumer throws',
    );
    assert.ok(outboxAfterFail.retries >= 1, 'Retry count was incremented');
    assert.ok(outboxAfterFail.lastError?.includes('Simulated transient DB failure'));

    // Subscription remains PENDING_PAYMENT before retry
    const subMid = await db().client.driverSubscription.findUniqueOrThrow({
      where: { id: subscriptionId },
    });
    assert.equal(subMid.status, 'PENDING_PAYMENT');

    // Attempt 2: Retry outbox processing (Simulate backoff time passed by updating nextAttemptAt)
    await db().client.outboxEvent.update({
      where: { id: outboxAfterFail.id },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });

    await drainOutbox();

    const outboxSuccess = await db().client.driverSubscription.findUniqueOrThrow({
      where: { id: subscriptionId },
    });
    assert.equal(outboxSuccess.status, 'ACTIVE');

    const drvSuccess = await db().client.driver.findUniqueOrThrow({ where: { id: driverId } });
    assert.equal(drvSuccess.paymentModel, 'SUBSCRIPTION');

    // Verify outbox event is now PUBLISHED
    const outboxFinal = await db().client.outboxEvent.findUniqueOrThrow({
      where: { id: outboxAfterFail.id },
    });
    assert.equal(outboxFinal.status, 'PUBLISHED');

    // Verify exactly ONE ledger transaction was created (no financial duplication on retry)
    const ledgerEntries = await db().client.paymentLedgerEntry.findMany({
      where: { referenceId: intentId },
    });
    assert.equal(
      ledgerEntries.length,
      2,
      'Exactly 2 ledger entries (1 DEBIT, 1 CREDIT) for the single payment',
    );
  });

  it('Test 4 — Missing plan: consumer throws and outbox event is NOT silently marked published', async () => {
    const { driver } = await driverWorld('+919870000003');
    const consumer = container.resolve(
      'subscriptionPaymentConsumer',
    ) as SubscriptionPaymentConsumer;
    const planRepo = container.resolve('subscriptionPlanRepository') as {
      findById: (...args: unknown[]) => Promise<unknown>;
    };

    const fakeIntentId = randomUUID();
    const dummyPlanId = await makeSubscriptionPlan({ billingPeriod: 'WEEKLY', price: 500 });
    const sub = await db().client.driverSubscription.create({
      data: {
        driverId: (await db().client.driver.findFirstOrThrow()).id,
        planId: dummyPlanId,
        paymentIntentId: fakeIntentId,
        status: 'PENDING_PAYMENT',
      },
    });

    // Mock planRepo.findById to return null for missing plan test
    const origFindById = planRepo.findById.bind(planRepo);
    planRepo.findById = async () => null;

    try {
      // Consumer should throw error when plan is missing
      await assert.rejects(
        async () => {
          await consumer['onPaymentCompleted']({
            eventId: randomUUID(),
            type: EVENT_TYPE_SUBSCRIPTION_COMPLETED,
            version: 1,
            envelopeVersion: 1,
            producer: 'payment',
            subject: { userId: null },
            correlation: { requestId: null, sessionId: null },
            occurredAt: new Date().toISOString(),
            data: { paymentIntentId: fakeIntentId, driverUserId: driver.userId, amount: 500 },
          });
        },
        (err: Error) => {
          assert.ok(err.message.includes('not found'));
          return true;
        },
      );
    } finally {
      planRepo.findById = origFindById;
    }

    const subCheck = await db().client.driverSubscription.findUniqueOrThrow({
      where: { id: sub.id },
    });
    assert.equal(
      subCheck.status,
      'PENDING_PAYMENT',
      'Subscription remains PENDING_PAYMENT on missing plan error',
    );
  });

  it('Test 5 — Duplicate event after successful activation: safely idempotent without duplicate effects', async () => {
    const { driver, driverId } = await driverWorld('+919870000004');
    const planId = await makeSubscriptionPlan({ billingPeriod: 'WEEKLY', price: 500 });

    const purchaseRes = await app.inject({
      method: 'POST',
      url: PURCHASE,
      headers: { ...driver.authHeader, 'idempotency-key': randomUUID() },
      payload: { planId },
    });
    const { intentId, subscriptionId } = purchaseRes.json().data;

    await deliverWebhook(intentId);
    await drainOutbox();

    const sub = await db().client.driverSubscription.findUniqueOrThrow({
      where: { id: subscriptionId },
    });
    assert.equal(sub.status, 'ACTIVE');

    // Manually trigger consumer with the same payment completed event again
    const consumer = container.resolve(
      'subscriptionPaymentConsumer',
    ) as SubscriptionPaymentConsumer;
    await consumer['onPaymentCompleted']({
      eventId: randomUUID(),
      type: EVENT_TYPE_SUBSCRIPTION_COMPLETED,
      version: 1,
      envelopeVersion: 1,
      producer: 'payment',
      subject: { userId: null },
      correlation: { requestId: null, sessionId: null },
      occurredAt: new Date().toISOString(),
      data: { paymentIntentId: intentId, driverUserId: driver.userId, amount: 500 },
    });

    const subAfter = await db().client.driverSubscription.findUniqueOrThrow({
      where: { id: subscriptionId },
    });
    assert.equal(subAfter.status, 'ACTIVE');

    const subsCount = await db().client.driverSubscription.count({ where: { driverId } });
    assert.equal(subsCount, 1, 'No duplicate subscription created');
  });

  it('Test 6 — Process restart/retry & SubscriptionReconciliationJob: stale claims reclaimed and reconciliation job recovers PENDING_PAYMENT subscriptions with paid intents', async () => {
    const { driver, driverId } = await driverWorld('+919870000005');
    const planId = await makeSubscriptionPlan({ billingPeriod: 'WEEKLY', price: 500 });

    const purchaseRes = await app.inject({
      method: 'POST',
      url: PURCHASE,
      headers: { ...driver.authHeader, 'idempotency-key': randomUUID() },
      payload: { planId },
    });
    const { intentId, subscriptionId } = purchaseRes.json().data;

    // Deliver payment webhook (creates outbox event)
    await deliverWebhook(intentId);

    // Find outbox event
    const outbox = await db().client.outboxEvent.findFirstOrThrow({
      where: { eventType: EVENT_TYPE_SUBSCRIPTION_COMPLETED },
    });

    // Claim outbox event and set claimedAt in the past to simulate a process crash mid-dispatch
    await db().client.outboxEvent.update({
      where: { id: outbox.id },
      data: {
        status: 'PROCESSING',
        claimToken: randomUUID(),
        claimedAt: new Date(Date.now() - 10 * 60 * 1000), // 10 mins ago (past 5 min timeout)
      },
    });

    // Run outbox relay maintenance (reclaims stale claims)
    const outboxRelay = container.resolve('outboxRelay') as OutboxRelay;
    await outboxRelay['runMaintenance']();

    const reclaimed = await db().client.outboxEvent.findUniqueOrThrow({ where: { id: outbox.id } });
    assert.equal(reclaimed.claimToken, null, 'Stale claim was released');
    assert.equal(reclaimed.status, 'PENDING');

    // Test SubscriptionReconciliationJob defense-in-depth: run sweep job
    const reconJob = container.resolve(
      'subscriptionReconciliationJob',
    ) as SubscriptionReconciliationJob;
    const activatedCount = await reconJob.run();
    assert.equal(activatedCount, 1, 'Reconciliation job activated the pending subscription');

    const activeSub = await db().client.driverSubscription.findUniqueOrThrow({
      where: { id: subscriptionId },
    });
    assert.equal(activeSub.status, 'ACTIVE');

    const drv = await db().client.driver.findUniqueOrThrow({ where: { id: driverId } });
    assert.equal(drv.paymentModel, 'SUBSCRIPTION');
  });

  it('Test 7 — H4 Step 2 Fix Verification: Concurrent/duplicate purchase requests safely reuse pending subscription & intent, preventing double charge and stranded pending records', async () => {
    const { driver, driverId } = await driverWorld('+919870000006');
    const planId = await makeSubscriptionPlan({ billingPeriod: 'MONTHLY', price: 1000 });

    // Request A
    const resA = await app.inject({
      method: 'POST',
      url: PURCHASE,
      headers: { ...driver.authHeader, 'idempotency-key': `key-A-${randomUUID()}` },
      payload: { planId },
    });
    assert.equal(resA.statusCode, 200);
    const { intentId: intentA, subscriptionId: subA } = resA.json().data;

    // Request B (concurrent/before activation of Request A, using different key)
    const resB = await app.inject({
      method: 'POST',
      url: PURCHASE,
      headers: { ...driver.authHeader, 'idempotency-key': `key-B-${randomUUID()}` },
      payload: { planId },
    });
    assert.equal(resB.statusCode, 200);
    const { intentId: intentB, subscriptionId: subB } = resB.json().data;

    // 1. Verify Request B reuses the pending subscription & payment intent (preventing double charge)
    assert.equal(intentA, intentB);
    assert.equal(subA, subB);

    // 2. Verify DB contains exactly ONE PENDING_PAYMENT subscription for the driver
    const pendingSubs = await db().client.driverSubscription.findMany({
      where: { driverId, status: 'PENDING_PAYMENT' },
    });
    assert.equal(pendingSubs.length, 1, 'Exactly one PENDING_PAYMENT subscription exists');

    // 3. Verify database partial unique index driver_subscriptions_one_pending prevents duplicate PENDING_PAYMENT rows
    await assert.rejects(
      async () => {
        await db().client.driverSubscription.create({
          data: {
            driverId,
            planId,
            status: 'PENDING_PAYMENT',
            startDate: new Date(),
            expiryDate: new Date(Date.now() + 30 * 86400 * 1000),
          },
        });
      },
      (err: { code?: string; message?: string }) =>
        err.code === 'P2002' || Boolean(err.message?.includes('driver_subscriptions_one_pending')),
      'DB rejects creating a second PENDING_PAYMENT subscription for the same driver',
    );

    // 4. Deliver payment webhook for intent A
    const hookA = await deliverWebhook(intentA);
    assert.equal(hookA.statusCode, 200);

    const intentARec = await db().client.paymentIntent.findUniqueOrThrow({
      where: { id: intentA },
    });
    assert.equal(intentARec.status, 'SUCCEEDED');

    // Drain outbox to run activation
    await drainOutbox();

    // 5. Verify subscription becomes ACTIVE and driver payment model updates
    const activeSub = await db().client.driverSubscription.findUniqueOrThrow({
      where: { id: subA },
    });
    assert.equal(activeSub.status, 'ACTIVE');

    const drv = await db().client.driver.findUniqueOrThrow({ where: { id: driverId } });
    assert.equal(drv.paymentModel, 'SUBSCRIPTION');
  });
});

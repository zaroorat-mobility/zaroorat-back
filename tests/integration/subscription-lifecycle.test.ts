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
import {
  acceptRide,
  bookRideRequest,
  finishRide,
  rideWorld,
  type RideWorld,
} from './helpers/ride-flow.js';
import {
  grantRole,
  makeDispatchOffer,
  makeDriver,
  makeSubscriptionPlan,
} from './helpers/fixtures.js';
import { container } from '../../src/core/di.js';
import { paymentConfig } from '../../src/config/payment/payment.config.js';
import { Decimal } from '../../src/modules/payments/types/index.js';
import type { Unsubscribe } from '../../src/core/events/index.js';
import type { SubscriptionExpiryJob } from '../../src/modules/subscriptions/jobs/subscription-expiry.job.js';

/// 004-driver-subscription-wallet. The real purchase → gateway → webhook →
/// activation pipeline, end to end — `driver-payment-model-flow.test.ts` and
/// `tests/unit/rides/driver-payment-model.test.ts` deliberately shortcut past
/// all of this via the `makeActiveSubscription` fixture (see its own comment:
/// "without re-running the whole purchase→webhook pipeline for tests that are
/// not themselves about that pipeline") — this file is that pipeline's own
/// test.

const PURCHASE = '/api/v1/subscriptions';
const STATUS = '/api/v1/subscriptions';
const PLANS = '/api/v1/subscriptions/plans';
const WEBHOOK = '/api/v1/payments/webhooks/razorpay';

describe('subscription purchase → payment → activation (integration, real HTTP)', () => {
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
    const driverId = await makeDriver(driverUser.userId, { verified: true, paymentModel: null });
    await drainOutbox();
    const driver = await loginAs(app, phone);
    return { driver, driverId };
  }

  function purchase(driver: { authHeader: { authorization: string } }, planId: string) {
    return app.inject({
      method: 'POST',
      url: PURCHASE,
      headers: { ...driver.authHeader, 'idempotency-key': randomUUID() },
      payload: { planId },
    });
  }

  function status(driver: { authHeader: { authorization: string } }) {
    return app.inject({ method: 'GET', url: STATUS, headers: driver.authHeader });
  }

  /// Real Razorpay webhook envelope, matching the shape every other webhook
  /// test in this suite uses (`event` at the top, the payment nested under
  /// `payload.payment.entity`, `order_id` as the order reference — accepted
  /// by `IntentService.findByGatewayReference` either as the gateway's own
  /// reference or, as here, the intent's own internal id).
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

  it('lists active plans', async () => {
    const { driver } = await driverWorld('+919876660001');
    await makeSubscriptionPlan({ billingPeriod: 'WEEKLY', price: 500 });

    const res = await app.inject({ method: 'GET', url: PLANS, headers: driver.authHeader });
    assert.equal(res.statusCode, 200, res.payload);
    assert.ok(res.json().data.length >= 1);
    assert.ok(
      res.json().data.every((p: { status?: string }) => !('status' in p)),
      'internal status is not leaked',
    );
  });

  it('purchase creates a PENDING_PAYMENT subscription and a PaymentIntent via the admin-active gateway — never activates on the purchase response alone', async () => {
    const { driver, driverId } = await driverWorld('+919876660002');
    const planId = await makeSubscriptionPlan({ billingPeriod: 'WEEKLY', price: 500 });

    const res = await purchase(driver, planId);
    assert.equal(res.statusCode, 200, res.payload);
    const { subscriptionId, status: subStatus, intentId } = res.json().data;
    assert.ok(subscriptionId);
    assert.ok(intentId);
    assert.equal(subStatus, 'PENDING_PAYMENT');

    const row = await db().client.driverSubscription.findUniqueOrThrow({
      where: { id: subscriptionId },
    });
    assert.equal(row.driverId, driverId);
    assert.equal(row.planId, planId);
    assert.equal(
      row.status,
      'PENDING_PAYMENT',
      'never ACTIVE from the purchase call itself (FR-003)',
    );

    const intent = await db().client.paymentIntent.findUniqueOrThrow({ where: { id: intentId } });
    assert.equal(intent.purpose, 'DRIVER_SUBSCRIPTION_PAYMENT');
    assert.equal(new Decimal(intent.amount).toFixed(2), '500.00');
    assert.ok(
      intent.gateway,
      'a gateway was resolved and pinned at creation, via the admin-active provider',
    );

    // Driver is not yet eligible — no ride can be accepted before activation.
    // `GET /subscriptions` reads `findActive` (status='ACTIVE' only), so a
    // still-pending purchase reports as no subscription at all, not as a
    // visible PENDING_PAYMENT state — a real product-visibility gap (the
    // driver has no way to see "your payment is processing" via this
    // endpoint), noted as a finding rather than changed here.
    const stat = await status(driver);
    assert.equal(stat.json().data, null);
  });

  it('activates on webhook confirmation, with the correct start date, expiry date and duration for the plan — and the driver becomes ride-eligible', async () => {
    // `rideWorld` with an explicit `paymentModel: null` skips its own
    // SUBSCRIPTION-with-active-subscription default (see its own comment) —
    // this driver has a vehicle/type ready but no payment model or
    // subscription at all yet, so eligibility here can only come from the
    // real purchase→webhook pipeline this test exercises, not the fixture
    // shortcut every other payment-model test deliberately uses instead.
    const world = await rideWorld(
      app,
      { customer: '+919876660004', driver: '+919876660003' },
      { driver: { paymentModel: null } },
    );
    const planId = await makeSubscriptionPlan({ billingPeriod: 'WEEKLY', price: 500 });

    const { intentId } = (await purchase(world.driver, planId)).json().data;
    const before = Date.now();
    const delivered = await deliverWebhook(intentId);
    assert.equal(delivered.statusCode, 200, delivered.payload);
    await drainOutbox();
    const after = Date.now();

    const stat = await status(world.driver);
    assert.equal(stat.json().data.status, 'ACTIVE');
    assert.equal(stat.json().data.paymentStatus, 'PAID');

    const row = await db().client.driverSubscription.findFirstOrThrow({
      where: { driverId: world.driverId, status: 'ACTIVE' },
    });
    const startMs = row.startDate!.getTime();
    const expiryMs = row.expiryDate!.getTime();
    assert.ok(
      startMs >= before - 1000 && startMs <= after + 1000,
      'start date is when it was confirmed',
    );
    const durationDays = (expiryMs - startMs) / (24 * 60 * 60 * 1000);
    assert.ok(
      Math.abs(durationDays - 7) < 0.01,
      `WEEKLY must add exactly 7 days, got ${durationDays}`,
    );

    const driverRow = await db().client.driver.findUniqueOrThrow({ where: { id: world.driverId } });
    assert.equal(
      driverRow.paymentModel,
      'SUBSCRIPTION',
      'BD-5: finalised only on confirmed activation',
    );

    // Ride eligibility — the payoff of activation.
    const requestId = await bookRideRequest(app, world, { distanceKm: 5 });
    const rideId = await acceptRide(app, world, requestId);
    const ride = await db().client.ride.findUniqueOrThrow({ where: { id: rideId } });
    assert.equal(ride.driverPaymentModel, 'SUBSCRIPTION');
    assert.equal(ride.commissionAmount, null);
  });

  it('computes DAILY and MONTHLY durations correctly too', async () => {
    for (const [period, expectDays] of [
      ['DAILY', 1],
      ['MONTHLY', null], // calendar month, checked separately below
    ] as const) {
      const { driver, driverId } = await driverWorld(
        period === 'DAILY' ? '+919876660006' : '+919876660007',
      );
      const planId = await makeSubscriptionPlan({ billingPeriod: period, price: 100 });
      const { intentId } = (await purchase(driver, planId)).json().data;
      await deliverWebhook(intentId);
      await drainOutbox();

      const row = await db().client.driverSubscription.findFirstOrThrow({
        where: { driverId, status: 'ACTIVE' },
      });
      if (period === 'DAILY') {
        const days = (row.expiryDate!.getTime() - row.startDate!.getTime()) / (24 * 60 * 60 * 1000);
        assert.ok(
          Math.abs(days - (expectDays as number)) < 0.01,
          `DAILY must add exactly 1 day, got ${days}`,
        );
      } else {
        const expectedMonth = new Date(row.startDate!);
        expectedMonth.setUTCMonth(expectedMonth.getUTCMonth() + 1);
        assert.equal(
          row.expiryDate!.toISOString(),
          expectedMonth.toISOString(),
          'MONTHLY must add exactly one calendar month',
        );
      }
    }
  });

  it('activates exactly once for a webhook delivered twice — no duplicate row, no double activation', async () => {
    const { driver, driverId } = await driverWorld('+919876660008');
    const planId = await makeSubscriptionPlan({ billingPeriod: 'WEEKLY', price: 500 });
    const { intentId } = (await purchase(driver, planId)).json().data;

    const eventId = `evt_${randomUUID()}`;
    const first = await deliverWebhook(intentId, eventId);
    await drainOutbox();
    const second = await deliverWebhook(intentId, eventId);
    await drainOutbox();

    assert.equal(first.statusCode, 200, first.payload);
    assert.equal(second.json().isDuplicate, true);

    const rows = await db().client.driverSubscription.findMany({ where: { driverId } });
    assert.equal(rows.length, 1, 'exactly one subscription row');
    assert.equal(rows[0]!.status, 'ACTIVE');

    // A distinct second event for the same intent — the generic
    // gateway-event guard would not catch this; `activateIfPending`'s
    // conditional claim (status must be PENDING_PAYMENT) is what does.
    await deliverWebhook(intentId);
    await drainOutbox();
    const stillOne = await db().client.driverSubscription.findMany({ where: { driverId } });
    assert.equal(stillOne.length, 1);
    assert.equal(
      stillOne[0]!.startDate!.getTime(),
      rows[0]!.startDate!.getTime(),
      'never re-dated',
    );
  });

  it('refuses purchasing the same plan again while already active', async () => {
    const { driver } = await driverWorld('+919876660009');
    const planId = await makeSubscriptionPlan({ billingPeriod: 'WEEKLY', price: 500 });
    const { intentId } = (await purchase(driver, planId)).json().data;
    await deliverWebhook(intentId);
    await drainOutbox();

    const again = await purchase(driver, planId);
    assert.equal(again.statusCode, 409, again.payload);
  });

  it('stages a plan change instead of starting a new payment when switching plans while active', async () => {
    const { driver, driverId } = await driverWorld('+919876660010');
    const planA = await makeSubscriptionPlan({ billingPeriod: 'WEEKLY', price: 500 });
    const planB = await makeSubscriptionPlan({ billingPeriod: 'MONTHLY', price: 1500 });
    const { intentId } = (await purchase(driver, planA)).json().data;
    await deliverWebhook(intentId);
    await drainOutbox();

    const switchRes = await purchase(driver, planB);
    assert.equal(switchRes.statusCode, 200, switchRes.payload);
    assert.equal(switchRes.json().data.intentId, null, 'no new payment for a staged change');

    const row = await db().client.driverSubscription.findFirstOrThrow({
      where: { driverId, status: 'ACTIVE' },
    });
    assert.equal(row.planId, planA, 'the current paid period runs its course');
    assert.equal(row.pendingPlanId, planB, 'the new plan is staged, not applied yet');
  });
});

describe('subscription expiry (integration, real HTTP)', () => {
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
    await resetState();
  });

  const expiryJob = () => container.resolve<SubscriptionExpiryJob>('subscriptionExpiryJob');

  /// Activates a real subscription (purchase → webhook, the same pipeline
  /// under test above) for a `rideWorld` driver that already has a vehicle
  /// ready, then backdates it so the expiry sweep will pick it up — never
  /// creates the driver a second time, unlike calling `rideWorld` again for
  /// the same phone number after a bare `makeDriver` would.
  async function purchaseAndActivate(
    world: RideWorld,
    billingPeriod: 'DAILY' | 'WEEKLY' | 'MONTHLY' = 'WEEKLY',
  ) {
    const planId = await makeSubscriptionPlan({ billingPeriod, price: 500 });
    const purchaseRes = await app.inject({
      method: 'POST',
      url: PURCHASE,
      headers: { ...world.driver.authHeader, 'idempotency-key': randomUUID() },
      payload: { planId },
    });
    const { intentId } = purchaseRes.json().data;
    const body = JSON.stringify({
      event: 'payment.captured',
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        payment: {
          entity: {
            id: `pay_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
            order_id: intentId,
            status: 'captured',
          },
        },
      },
    });
    await app.inject({
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
        'x-razorpay-event-id': `evt_${randomUUID()}`,
      },
      payload: body,
    });
    await drainOutbox();
    return db().client.driverSubscription.findFirstOrThrow({
      where: { driverId: world.driverId, status: 'ACTIVE' },
    });
  }

  async function expireNow(subscriptionId: string) {
    await db().client.driverSubscription.update({
      where: { id: subscriptionId },
      data: { expiryDate: new Date(Date.now() - 1000) },
    });
  }

  it('the expiry sweep expires a subscription past its expiry date', async () => {
    const world = await rideWorld(
      app,
      { customer: '+919876660016', driver: '+919876660011' },
      { driver: { paymentModel: null } },
    );
    const subscription = await purchaseAndActivate(world);
    await expireNow(subscription.id);

    const expired = await expiryJob().run();
    assert.ok(expired >= 1, JSON.stringify(expired));

    const after = await db().client.driverSubscription.findUniqueOrThrow({
      where: { id: subscription.id },
    });
    assert.equal(after.status, 'EXPIRED');
  });

  it('a driver is not eligible for a NEW ride once their subscription has expired', async () => {
    const world = await rideWorld(
      app,
      { customer: '+919876660013', driver: '+919876660012' },
      { driver: { paymentModel: null } },
    );
    const subscription = await purchaseAndActivate(world);
    await expireNow(subscription.id);
    await expiryJob().run();

    const requested = await app.inject({
      method: 'POST',
      url: '/api/v1/rides/requests',
      headers: world.customer.authHeader,
      payload: {
        vehicleTypeId: world.vehicleTypeId,
        pickupLat: 12.9716,
        pickupLng: 77.5946,
        dropLat: 12.9806,
        dropLng: 77.5946,
        paymentMethod: 'CARD',
      },
    });
    assert.equal(requested.statusCode, 200, requested.payload);
    const requestId = requested.json().data.id as string;
    await makeDispatchOffer(requestId, world.driverId);
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/v1/rides/accept',
      headers: world.driver.authHeader,
      payload: { requestId, vehicleId: world.vehicleId },
    });
    assert.equal(accepted.statusCode, 409, accepted.payload);
    assert.equal(accepted.json().error.code, 'DRIVER_SUBSCRIPTION_REQUIRED');
  });

  it('an already-accepted ride continues and completes normally even if the subscription expires mid-ride', async () => {
    const world = await rideWorld(
      app,
      { customer: '+919876660014', driver: '+919876660015' },
      { driver: { paymentModel: null } },
    );
    // Activate a real subscription that has NOT yet expired, accept the ride
    // while it is still valid, then expire it out from under the ride.
    await purchaseAndActivate(world);

    const requestId = await bookRideRequest(app, world, { distanceKm: 6 });
    const rideId = await acceptRide(app, world, requestId);
    const acceptedRide = await db().client.ride.findUniqueOrThrow({ where: { id: rideId } });
    assert.equal(
      acceptedRide.driverPaymentModel,
      'SUBSCRIPTION',
      'precondition: accepted under SUBSCRIPTION',
    );

    // Expire the subscription while the ride is IN_PROGRESS.
    await db().client.driverSubscription.updateMany({
      where: { driverId: world.driverId, status: 'ACTIVE' },
      data: { expiryDate: new Date(Date.now() - 1000) },
    });
    await expiryJob().run();
    const expiredRow = await db().client.driverSubscription.findFirstOrThrow({
      where: { driverId: world.driverId },
    });
    assert.equal(
      expiredRow.status,
      'EXPIRED',
      'precondition: the sweep really did expire it mid-ride',
    );

    // The ride is unaffected: completion never re-checks subscription state,
    // it only reads what was fixed on the Ride row at acceptance.
    await finishRide(app, world, rideId, { distanceKm: 6, durationMin: 13 });
    const completed = await db().client.ride.findUniqueOrThrow({ where: { id: rideId } });
    assert.equal(
      completed.status,
      'COMPLETED',
      'the ride was not interrupted by the mid-ride expiry',
    );
    assert.equal(
      await db().client.driverCommissionWalletTransaction.count({ where: { rideId } }),
      0,
      'still no commission-wallet activity — this ride was always SUBSCRIPTION-model',
    );
  });
});

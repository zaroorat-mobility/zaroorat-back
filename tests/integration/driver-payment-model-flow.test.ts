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
  accountBalance,
  bookRideRequest,
  finishRide,
  rideWorld,
  type RideWorld,
} from './helpers/ride-flow.js';
import {
  grantRole,
  makeActiveSubscription,
  makeDriver,
  makeDispatchOffer,
  RIDE_PIN,
} from './helpers/fixtures.js';
import { container } from '../../src/core/di.js';
import { redis } from '../../src/core/cache/client.js';
import { RedisKeys } from '../../src/core/cache/keys.js';
import { paymentConfig } from '../../src/config/payment/payment.config.js';
import type { TransactionManager } from '../../src/core/database/index.js';
import type { CommissionWalletService } from '../../src/modules/payments/services/commission-wallet/commission-wallet.service.js';
import type { SettlementService } from '../../src/modules/payments/services/settlement/settlement.service.js';
import { Decimal } from '../../src/modules/payments/types/index.js';
import type { Unsubscribe } from '../../src/core/events/index.js';

const CASH_CONFIRM_FLAG = 'PAYMENT_CASH_CONFIRMATION_REQUIRED';
const settlementService = () => container.resolve<SettlementService>('settlementService');

/// 004-driver-subscription-wallet — the real-PostgreSQL counterpart to
/// `tests/unit/rides/driver-payment-model.test.ts`. That suite proves the
/// COMMISSION/SUBSCRIPTION flow against mocked repositories; this one proves
/// the same invariants against a real database — real Prisma transactions,
/// real row locks, and the real `commission_wallet_one_deduction_per_ride`
/// partial unique index — via the unmodified, DI-resolved services.

const txManager = () => container.resolve<TransactionManager>('transactionManager');
const commissionWalletService = () =>
  container.resolve<CommissionWalletService>('commissionWalletService');

async function commissionWallet(driverId: string) {
  return db().client.driverCommissionWallet.findUniqueOrThrow({ where: { driverId } });
}

async function commissionWalletOrNull(driverId: string) {
  return db().client.driverCommissionWallet.findUnique({ where: { driverId } });
}

async function commissionWalletTransactions(driverId: string) {
  return db().client.driverCommissionWalletTransaction.findMany({
    where: { driverId },
    orderBy: { createdAt: 'asc' },
  });
}

/// Offers and attempts to accept a request WITHOUT asserting success — for
/// the negative-path cases `acceptRide` (which asserts 200) cannot express.
async function attemptAccept(app: FastifyInstance, world: RideWorld, requestId: string) {
  await makeDispatchOffer(requestId, world.driverId);
  return app.inject({
    method: 'POST',
    url: '/api/v1/rides/accept',
    headers: world.driver.authHeader,
    payload: { requestId, vehicleId: world.vehicleId },
  });
}

let app: FastifyInstance;
let stopConsumers: Unsubscribe;

describe('COMMISSION driver — real PostgreSQL financial flow (004-driver-subscription-wallet)', () => {
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

  it('determines commission once at acceptance, stores it, never deducts/reserves at acceptance, then deducts the exact stored amount at completion', async () => {
    const w = await rideWorld(
      app,
      { customer: '+919876650001', driver: '+919876650002' },
      { driver: { paymentModel: 'COMMISSION', commissionWalletBalance: 100_000 } },
    );
    const walletBeforeAccept = (await commissionWallet(w.driverId)).balance;

    const requestId = await bookRideRequest(app, w, { distanceKm: 8 });
    const rideId = await acceptRide(app, w, requestId);

    // spec.md FR-013b/FR-014 — determined and stored exactly once, at accept.
    const rideAfterAccept = await db().client.ride.findUniqueOrThrow({ where: { id: rideId } });
    assert.equal(rideAfterAccept.driverPaymentModel, 'COMMISSION');
    assert.ok(
      rideAfterAccept.commissionAmount != null,
      'commission must be determined and stored at acceptance',
    );
    const storedCommission = new Decimal(rideAfterAccept.commissionAmount!);
    assert.ok(
      storedCommission.gt(0),
      'the seeded pricing must produce a positive commission for this test to be meaningful',
    );

    // FR-017a — a read-only comparison; the wallet itself is untouched.
    const walletAfterAccept = (await commissionWallet(w.driverId)).balance;
    assert.equal(
      walletAfterAccept.toFixed(2),
      walletBeforeAccept.toFixed(2),
      'acceptance must not deduct, freeze or reserve any part of the wallet',
    );
    assert.equal(
      (await commissionWalletTransactions(w.driverId)).length,
      0,
      'no wallet transaction of any kind may exist before completion',
    );

    await finishRide(app, w, rideId, { distanceKm: 8, durationMin: 15 });

    // FR-020 — read, not recalculated.
    const rideAfterComplete = await db().client.ride.findUniqueOrThrow({ where: { id: rideId } });
    assert.equal(
      new Decimal(rideAfterComplete.commissionAmount!).toFixed(2),
      storedCommission.toFixed(2),
      'the stored commission is immutable — completion must not alter it',
    );

    // FR-022 — the full stored amount, exactly.
    const walletAfterComplete = (await commissionWallet(w.driverId)).balance;
    assert.equal(
      walletAfterComplete.toFixed(2),
      walletBeforeAccept.sub(storedCommission).toFixed(2),
      'the wallet must drop by exactly the stored commission — e.g. ₹500 wallet, ₹100 stored commission → ₹400',
    );

    // FR-012/FR-023 — one immutable transaction, one balanced ledger entry.
    const txs = await commissionWalletTransactions(w.driverId);
    assert.equal(txs.length, 1);
    assert.equal(txs[0]!.txnType, 'RIDE_COMMISSION');
    assert.equal(txs[0]!.rideId, rideId);
    assert.equal(new Decimal(txs[0]!.amount).neg().toFixed(2), storedCommission.toFixed(2));
    assert.equal(new Decimal(txs[0]!.balanceAfter).toFixed(2), walletAfterComplete.toFixed(2));

    const walletLeg = await accountBalance('DRIVER_COMMISSION_WALLET', {
      accountRefId: w.driverId,
      rideId,
    });
    const platformLeg = await accountBalance('PLATFORM_COMMISSION', { rideId });
    assert.equal(
      walletLeg.toFixed(2),
      storedCommission.neg().toFixed(2),
      'wallet leg debited by the stored amount',
    );
    assert.equal(
      platformLeg.toFixed(2),
      storedCommission.toFixed(2),
      'commission account credited by the same amount',
    );
    assert.equal(walletLeg.add(platformLeg).toFixed(2), '0.00', 'the ledger group must balance');
  });

  it('deducts the accept-time stored commission even when the completion-time customer fare is wildly different — never recalculated', async () => {
    const w = await rideWorld(
      app,
      { customer: '+919876650003', driver: '+919876650004' },
      { driver: { paymentModel: 'COMMISSION', commissionWalletBalance: 100_000 } },
    );
    const walletBefore = (await commissionWallet(w.driverId)).balance;

    const requestId = await bookRideRequest(app, w, { distanceKm: 5 });
    const rideId = await acceptRide(app, w, requestId);
    const ride = await db().client.ride.findUniqueOrThrow({ where: { id: rideId } });
    const storedCommission = new Decimal(ride.commissionAmount!);

    // `LifecycleService.startRide` resets the trip-distance meter at the end
    // of its own transaction (so a new trip starts from zero) — so the meter
    // has to be seeded *after* `/start`, not before `/arrive`, or `/start`
    // wipes it before `/complete` ever reads it.
    const arrived = await app.inject({
      method: 'POST',
      url: `/api/v1/rides/${rideId}/arrive`,
      headers: w.driver.authHeader,
      payload: {},
    });
    assert.equal(arrived.statusCode, 200, arrived.payload);
    const started = await app.inject({
      method: 'POST',
      url: `/api/v1/rides/${rideId}/start`,
      headers: w.driver.authHeader,
      payload: { pin: RIDE_PIN },
    });
    assert.equal(started.statusCode, 200, started.payload);

    // `billedDistanceKm` is `max(Redis trip meter, quoted km)` — the
    // client-declared `actualDistanceKm` passed to `/complete` below does not
    // drive billing at all, so the meter is what has to move to make the
    // completion-time customer fare genuinely different from the ~5km quote
    // acceptance priced the commission on. Seeding it directly mirrors the
    // established pattern elsewhere in this suite (see
    // otp-hardening.test.ts's direct Redis fixture writes).
    await redis.set(RedisKeys.tripDistance(w.driverId), '120');
    // Duration is measured from the server's own clock
    // (`completedAt - ride.startedAt`), not from the client-declared value —
    // so it has to be pushed back the same way `cash-settlement.test.ts`'s
    // `ageBeyondGrace` pushes `completedAt` back, or the plausibility bound
    // (measured against real elapsed wall-clock time, here mere seconds)
    // refuses the 100-minute trip this test is declaring.
    await db().client.ride.update({
      where: { id: rideId },
      data: { startedAt: new Date(Date.now() - 100 * 60_000) },
    });

    const completed = await app.inject({
      method: 'POST',
      url: `/api/v1/rides/${rideId}/complete`,
      headers: w.driver.authHeader,
      payload: { actualDistanceKm: 120, actualDurationMin: 100 },
    });
    assert.equal(completed.statusCode, 200, completed.payload);
    const fare = (await db().client.rideFare.findUniqueOrThrow({
      where: { rideId },
    })) as unknown as { totalFare: Decimal; driverEarning: Decimal; platformCommission: Decimal };

    // Prove the setup actually diverged — otherwise this test would pass for
    // the wrong reason (both figures coincidentally computed from ~0 input).
    assert.notEqual(
      fare.platformCommission.toFixed(2),
      storedCommission.toFixed(2),
      'the completion-time customer-fare commission and the accept-time stored commission must differ for this to prove anything',
    );

    const rideAfter = await db().client.ride.findUniqueOrThrow({ where: { id: rideId } });
    assert.equal(
      new Decimal(rideAfter.commissionAmount!).toFixed(2),
      storedCommission.toFixed(2),
      'Ride.commissionAmount is untouched by the final customer fare',
    );

    const walletAfter = (await commissionWallet(w.driverId)).balance;
    assert.equal(
      walletAfter.toFixed(2),
      walletBefore.sub(storedCommission).toFixed(2),
      'the wallet deduction must equal the accept-time stored commission, not fare.platformCommission × anything',
    );
  });

  it('CARD (paid to the driver directly) — commission comes only from the wallet, never a second PLATFORM_COMMISSION', async () => {
    const w = await rideWorld(
      app,
      { customer: '+919876650024', driver: '+919876650025' },
      { driver: { paymentModel: 'COMMISSION', commissionWalletBalance: 100_000 } },
    );
    const requestId = await bookRideRequest(app, w, { distanceKm: 7, paymentMethod: 'CARD' });
    const rideId = await acceptRide(app, w, requestId);
    const ride = await db().client.ride.findUniqueOrThrow({ where: { id: rideId } });
    const storedCommission = new Decimal(ride.commissionAmount!);

    await finishRide(app, w, rideId, { distanceKm: 7, durationMin: 14 });

    // The customer pays the driver directly for a CARD ride, exactly like
    // cash, so both the wallet deduction AND the trip's ledger group are
    // posted synchronously in the completion transaction — there is no
    // separate, later collection step to double the commission. The wallet
    // deduction posted its own PLATFORM_COMMISSION credit for the stored
    // amount; `recordTripPayment`'s own credit side redistributes the
    // commission-sized component to the driver instead (it is already owned
    // by the wallet deduction), so it contributes nothing further here. If
    // either step still posted PLATFORM_COMMISSION unconditionally (the old,
    // gateway-routed behaviour), the balance below would roughly double.
    const ride2 = await db().client.ride.findUniqueOrThrow({ where: { id: rideId } });
    assert.equal(
      ride2.paymentStatus,
      'PAID',
      'settled at completion — the driver already has the money',
    );
    assert.equal(
      (await accountBalance('PLATFORM_COMMISSION', { rideId })).toFixed(2),
      storedCommission.toFixed(2),
      'commission recognition is the wallet deduction alone — the trip ledger group must never add a second credit',
    );
    assert.equal(
      await db().client.driverCommissionWalletTransaction.count({ where: { rideId } }),
      1,
      'exactly one RIDE_COMMISSION transaction, regardless of how the customer paid',
    );

    // The completion consumer still runs off the outbox — a redelivery must
    // find the obligation already settled and do nothing, not double-post.
    await drainOutbox();
    assert.equal(
      (await accountBalance('PLATFORM_COMMISSION', { rideId })).toFixed(2),
      storedCommission.toFixed(2),
      'still exactly once after the completion consumer runs',
    );
  });
});

describe('SUBSCRIPTION driver — real PostgreSQL flow (004-driver-subscription-wallet)', () => {
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

  it('accepts and completes a ride with zero Commission Wallet activity', async () => {
    const w = await rideWorld(
      app,
      { customer: '+919876650005', driver: '+919876650006' },
      { driver: { paymentModel: 'SUBSCRIPTION' } },
    );
    await makeActiveSubscription(w.driverId);

    const requestId = await bookRideRequest(app, w, { distanceKm: 6 });
    const rideId = await acceptRide(app, w, requestId);

    const ride = await db().client.ride.findUniqueOrThrow({ where: { id: rideId } });
    assert.equal(ride.driverPaymentModel, 'SUBSCRIPTION');
    assert.equal(
      ride.commissionAmount,
      null,
      'FR-024c: no commission amount may be determined or stored for a subscription ride',
    );
    assert.equal(
      await commissionWalletOrNull(w.driverId),
      null,
      'no Commission Wallet row is ever created for a subscription-only driver',
    );

    await finishRide(app, w, rideId, { distanceKm: 6, durationMin: 12 });

    assert.equal(
      await commissionWalletOrNull(w.driverId),
      null,
      'completion must not create a Commission Wallet either',
    );
    assert.equal(
      (await db().client.driverCommissionWalletTransaction.findMany({ where: { rideId } })).length,
      0,
      'no RIDE_COMMISSION transaction may be created',
    );
    assert.equal(
      (await accountBalance('DRIVER_COMMISSION_WALLET', { rideId })).toFixed(2),
      '0.00',
      'no commission ledger entry may be posted',
    );
    assert.equal(
      (await accountBalance('PLATFORM_COMMISSION', { rideId })).toFixed(2),
      '0.00',
      'no driver-commission ledger posting of any kind for a SUBSCRIPTION ride — not even through customer payment collection',
    );

    const finalRide = await db().client.ride.findUniqueOrThrow({ where: { id: rideId } });
    assert.equal(finalRide.status, 'COMPLETED', 'the ride itself completes exactly as normal');
  });

  it('CASH — zero Commission Wallet activity, and cash settlement never recognises commission either', async () => {
    const w = await rideWorld(
      app,
      { customer: '+919876650009', driver: '+919876650010' },
      { driver: { paymentModel: 'SUBSCRIPTION' } },
    );
    await makeActiveSubscription(w.driverId);

    const requestId = await bookRideRequest(app, w, { distanceKm: 6, paymentMethod: 'CASH' });
    const rideId = await acceptRide(app, w, requestId);
    const fare = await finishRide(app, w, rideId, { distanceKm: 6, durationMin: 12 });

    assert.equal(
      await commissionWalletOrNull(w.driverId),
      null,
      'a subscription driver never gets a Commission Wallet, cash ride or not',
    );
    assert.equal(
      (await db().client.driverCommissionWalletTransaction.findMany({ where: { rideId } })).length,
      0,
      'no RIDE_COMMISSION transaction for a cash ride either',
    );
    assert.equal(
      (await accountBalance('PLATFORM_COMMISSION', { rideId })).toFixed(2),
      '0.00',
      "the subscription fee is this driver's entire commission obligation — cash settlement recognises none",
    );
    // The customer's cash payment is still recorded correctly: the driver
    // owes back the tax and platform fee they're holding, exactly as any
    // cash ride requires, independent of commission entirely.
    assert.equal(
      (await accountBalance('DRIVER_PAYABLE', { accountRefId: w.driverId, rideId })).toFixed(2),
      new Decimal(fare.totalFare)
        .sub(fare.driverEarning)
        .sub(fare.platformCommission)
        .neg()
        .toFixed(2),
    );
  });

  it('refuses acceptance for a SUBSCRIPTION driver with no active subscription', async () => {
    const w = await rideWorld(
      app,
      { customer: '+919876650007', driver: '+919876650008' },
      { driver: { paymentModel: 'SUBSCRIPTION' } },
    );
    // Deliberately no makeActiveSubscription() call.

    const requestId = await bookRideRequest(app, w, { distanceKm: 5 });
    const resp = await attemptAccept(app, w, requestId);

    assert.equal(resp.statusCode, 409, resp.payload);
    assert.equal(resp.json().error.code, 'DRIVER_SUBSCRIPTION_REQUIRED');
    assert.equal(
      (await db().client.ride.findMany({ where: { requestId } })).length,
      0,
      'no ride may be created',
    );
  });
});

describe('duplicate ride completion cannot deduct commission twice (real PostgreSQL, real transaction/lock/unique-index)', () => {
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

  it('deducts exactly once even when the wallet deduction is invoked a second time for the same ride', async () => {
    const w = await rideWorld(
      app,
      { customer: '+919876650009', driver: '+919876650010' },
      { driver: { paymentModel: 'COMMISSION', commissionWalletBalance: 100_000 } },
    );
    const requestId = await bookRideRequest(app, w, { distanceKm: 7 });
    const rideId = await acceptRide(app, w, requestId);
    const ride = await db().client.ride.findUniqueOrThrow({ where: { id: rideId } });
    const storedCommission = new Decimal(ride.commissionAmount!);
    const walletBefore = (await commissionWallet(w.driverId)).balance;

    await finishRide(app, w, rideId, { distanceKm: 7, durationMin: 14 });

    const walletAfterFirst = (await commissionWallet(w.driverId)).balance;
    assert.equal(walletAfterFirst.toFixed(2), walletBefore.sub(storedCommission).toFixed(2));

    // Simulates a retried/redelivered completion trigger reaching the
    // deduction code a second time. In production the ride-status conditional
    // claim already blocks a second *HTTP* completion from getting this far,
    // AND `RideFare`'s own per-ride uniqueness constraint independently blocks
    // a second full `LifecycleService.completeRide` run — so this drives the
    // real, DI-resolved `CommissionWalletService.deductInTx` (the exact
    // method `completeRide` calls) directly, against the real database inside
    // a real transaction, isolating and proving the specific guarantee
    // spec.md FR-021 names: the `commission_wallet_one_deduction_per_ride`
    // unique index plus the check-before-write inside `deductInTx` itself.
    const second = await txManager().execute((tx) =>
      commissionWalletService().deductInTx(w.driverId, rideId, storedCommission, tx),
    );
    assert.equal(second.outcome, 'ALREADY_PROCESSED');

    const walletAfterSecond = (await commissionWallet(w.driverId)).balance;
    assert.equal(
      walletAfterSecond.toFixed(2),
      walletAfterFirst.toFixed(2),
      'the second completion must not deduct again — wallet stays at the post-first-completion balance',
    );

    const txs = await commissionWalletTransactions(w.driverId);
    assert.equal(
      txs.length,
      1,
      'only one RIDE_COMMISSION transaction may ever exist for this ride',
    );

    const walletLeg = await accountBalance('DRIVER_COMMISSION_WALLET', {
      accountRefId: w.driverId,
      rideId,
    });
    assert.equal(
      walletLeg.toFixed(2),
      storedCommission.neg().toFixed(2),
      'only one ledger debit exists — not two',
    );
  });
});

describe('duplicate wallet recharge webhook cannot credit twice (real PostgreSQL)', () => {
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

  it('credits the Commission Wallet only once for a payment.succeeded webhook delivered twice', async () => {
    const phone = '+919876650011';
    const driverUser = await loginAs(app, phone);
    await grantRole(driverUser.userId, 'driver');
    const driverId = await makeDriver(driverUser.userId, {
      verified: true,
      paymentModel: 'COMMISSION',
      commissionWalletBalance: 100,
    });
    await drainOutbox();
    const driver = await loginAs(app, phone);

    const recharge = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/driver-wallet/recharge',
      headers: { ...driver.authHeader, 'idempotency-key': randomUUID() },
      payload: { amount: 500 },
    });
    assert.equal(recharge.statusCode, 200, recharge.payload);
    const gatewayIntentId = recharge.json().data.gatewayIntentId;

    // The recharge call itself must never have credited anything — spec.md
    // FR-009: only independent provider confirmation may.
    assert.equal((await commissionWallet(driverId)).balance.toFixed(2), '100.00');

    // Real Razorpay webhook shape (`event` at the top, the payment nested
    // under `payload.payment.entity`, `order_id` — not a body-level `id` —
    // as the order reference) — not the generic Stripe-like envelope this
    // test used before per-provider parsing existed.
    const paymentId = `pay_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
    const body = JSON.stringify({
      event: 'payment.captured',
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        payment: {
          entity: { id: paymentId, order_id: gatewayIntentId, status: 'captured' },
        },
      },
    });
    const signature = createHmac(
      'sha256',
      paymentConfig.razorpayWebhookSecret ?? paymentConfig.webhookSecret,
    )
      .update(body)
      .digest('hex');
    const eventId = `evt_${randomUUID()}`;
    const headers = {
      'content-type': 'application/json',
      'x-razorpay-signature': signature,
      'x-razorpay-event-id': eventId,
    };

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/webhooks/razorpay',
      headers,
      payload: body,
    });
    assert.equal(first.statusCode, 200, first.payload);
    assert.equal((await commissionWallet(driverId)).balance.toFixed(2), '600.00');

    // The exact same event (`id`), delivered again — the existing, generic
    // webhook idempotency mechanism (`gatewayEventId` uniqueness in
    // WebhookRepository.findOrPersist) must treat this as a no-op. No second
    // mechanism is introduced for this purpose.
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/webhooks/razorpay',
      headers,
      payload: body,
    });
    assert.equal(second.statusCode, 200, second.payload);

    assert.equal(
      (await commissionWallet(driverId)).balance.toFixed(2),
      '600.00',
      'a redelivered webhook must not credit the wallet twice',
    );

    const txs = await commissionWalletTransactions(driverId);
    assert.equal(txs.length, 1, 'exactly one wallet credit transaction exists');
    assert.equal(txs[0]!.txnType, 'MANUAL_RECHARGE');
    assert.equal(new Decimal(txs[0]!.amount).toFixed(2), '500.00');
  });
});

describe('wallet eligibility at acceptance (real PostgreSQL)', () => {
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

  it('CASE A — sufficient balance: ride is accepted and the wallet balance is unchanged immediately after acceptance', async () => {
    const w = await rideWorld(
      app,
      { customer: '+919876650012', driver: '+919876650013' },
      { driver: { paymentModel: 'COMMISSION', commissionWalletBalance: 100_000 } },
    );
    const requestId = await bookRideRequest(app, w, { distanceKm: 5 });
    const walletBefore = (await commissionWallet(w.driverId)).balance;

    const rideId = await acceptRide(app, w, requestId);

    const walletAfter = (await commissionWallet(w.driverId)).balance;
    assert.equal(walletAfter.toFixed(2), walletBefore.toFixed(2));
    const ride = await db().client.ride.findUniqueOrThrow({ where: { id: rideId } });
    assert.ok(ride.commissionAmount != null);
  });

  it('CASE B — insufficient balance: ride is rejected, wallet untouched, no ride/transaction/reservation created', async () => {
    // Determine the real commission from a throwaway, well-funded driver
    // first, so "insufficient" is guaranteed true against whatever the
    // seeded pricing configuration actually produces, rather than a guessed
    // constant.
    const probe = await rideWorld(
      app,
      { customer: '+919876650014', driver: '+919876650015' },
      { driver: { paymentModel: 'COMMISSION', commissionWalletBalance: 100_000 } },
    );
    const probeRequestId = await bookRideRequest(app, probe, { distanceKm: 5 });
    const probeRideId = await acceptRide(app, probe, probeRequestId);
    const probeRide = await db().client.ride.findUniqueOrThrow({ where: { id: probeRideId } });
    const commission = new Decimal(probeRide.commissionAmount!);
    assert.ok(commission.gt(0), 'need a positive commission for "insufficient" to mean anything');

    const w = await rideWorld(
      app,
      { customer: '+919876650016', driver: '+919876650017' },
      { driver: { paymentModel: 'COMMISSION', commissionWalletBalance: 0 } },
    );
    const requestId = await bookRideRequest(app, w, { distanceKm: 5 });

    const resp = await attemptAccept(app, w, requestId);
    assert.equal(resp.statusCode, 409, resp.payload);
    assert.equal(resp.json().error.code, 'INSUFFICIENT_COMMISSION_BALANCE');

    assert.equal((await commissionWallet(w.driverId)).balance.toFixed(2), '0.00');
    assert.equal(
      (await db().client.ride.findMany({ where: { requestId } })).length,
      0,
      'no ride may be created on rejection',
    );
    const request = await db().client.rideRequest.findUniqueOrThrow({ where: { id: requestId } });
    assert.ok(
      ['CREATED', 'SEARCHING'].includes(request.status),
      `the request must stay claimable by another driver (was ${request.status})`,
    );
    assert.equal(
      (await commissionWalletTransactions(w.driverId)).length,
      0,
      'no wallet transaction or reservation of any kind may be created on rejection',
    );
  });
});

describe('TD-1, flag OFF — cash-settlement/recovery never nets a commission already collected via the wallet (real PostgreSQL)', () => {
  before(async () => {
    // `ride-payment.routes.ts` registers `/payment/confirm-cash` conditionally
    // on this flag at boot time, so it must be settled before `bootApp()`,
    // not merely before the request — matching cash-settlement.test.ts's own
    // two-describe-blocks-one-app-each pattern.
    delete process.env[CASH_CONFIRM_FLAG];
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

  it('the immediate cash-settlement ledger posting excludes commission already collected via the wallet', async () => {
    const w = await rideWorld(
      app,
      { customer: '+919876650018', driver: '+919876650019' },
      { driver: { paymentModel: 'COMMISSION', commissionWalletBalance: 100_000 } },
    );
    const requestId = await bookRideRequest(app, w, { distanceKm: 6, paymentMethod: 'CASH' });
    const rideId = await acceptRide(app, w, requestId);
    const ride = await db().client.ride.findUniqueOrThrow({ where: { id: rideId } });
    const storedCommission = new Decimal(ride.commissionAmount!);
    const walletBefore = (await commissionWallet(w.driverId)).balance;

    const fare = await finishRide(app, w, rideId, { distanceKm: 6, durationMin: 12 });

    // The wallet deduction happened, as usual.
    assert.equal(
      (await commissionWallet(w.driverId)).balance.toFixed(2),
      walletBefore.sub(storedCommission).toFixed(2),
    );

    // If TD-1 were unimplemented, PLATFORM_COMMISSION would carry TWO
    // credits for this one ride — the wallet deduction's, and a second one
    // from the cash-settlement ledger posting derived from the completion
    // fare — summing to roughly double the stored commission.
    const platformCommissionTotal = await accountBalance('PLATFORM_COMMISSION', { rideId });
    assert.equal(
      platformCommissionTotal.toFixed(2),
      storedCommission.toFixed(2),
      'PLATFORM_COMMISSION must reflect the wallet deduction only — not also the cash-settlement posting',
    );

    // The driver still owes back the tax and platform fee they're holding —
    // just not the commission a second time.
    const driverPayableTotal = await accountBalance('DRIVER_PAYABLE', {
      accountRefId: w.driverId,
      rideId,
    });
    assert.equal(
      driverPayableTotal.toFixed(2),
      fare.totalFare.sub(fare.driverEarning).sub(fare.platformCommission).neg().toFixed(2),
      'the driver still owes tax + platform fee via the cash-settlement debit, minus the commission already collected',
    );
  });

  it('batch settlement never nets a ride whose commission was already collected via the wallet', async () => {
    const w = await rideWorld(
      app,
      { customer: '+919876650022', driver: '+919876650023' },
      { driver: { paymentModel: 'COMMISSION', commissionWalletBalance: 100_000 } },
    );
    const requestId = await bookRideRequest(app, w, { distanceKm: 6, paymentMethod: 'CASH' });
    const rideId = await acceptRide(app, w, requestId);
    await finishRide(app, w, rideId, { distanceKm: 6, durationMin: 12 });

    const fare = await db().client.rideFare.findUniqueOrThrow({ where: { rideId } });
    const periodStart = new Date(Date.now() - 60_000);
    const periodEnd = new Date(Date.now() + 60_000);

    const settlement = await settlementService().calculateSettlement({
      driverId: w.driverId,
      periodStart,
      periodEnd,
    });

    // The driver still owes back the tax + platform fee they're holding via
    // settlement (nothing recovers that at completion when the flag is off)
    // — that debt reduces `netPayable` below, but it is tax + fee, never
    // commission, so it must not appear in the settlement's `commission`
    // figure. This driver's commission was already collected via the wallet
    // and settlement must never recognise it a second time.
    const expectedOwedOnCash = new Decimal(fare.totalFare)
      .sub(fare.driverEarning)
      .sub(fare.platformCommission);
    assert.equal(
      new Decimal(settlement.commission).toFixed(2),
      '0.00',
      'settlement must never recognise commission for a ride with a payment model',
    );
    // `earnedOnCollected` excludes cash rides entirely — the driver already
    // holds that fare directly, so settlement pays them nothing further for
    // it; `netPayable` here is purely `-stillOwedOnCash` (tax+fee only, not
    // also the commission this ride's wallet deduction already collected).
    assert.equal(
      new Decimal(settlement.netPayable).toFixed(2),
      expectedOwedOnCash.neg().toFixed(2),
      'netPayable must only deduct tax+fee for this ride, not the commission a second time',
    );
  });
});

describe('TD-1, flag ON — RideCollectionService.confirmCash excludes commission already collected via the wallet (real PostgreSQL)', () => {
  before(async () => {
    process.env[CASH_CONFIRM_FLAG] = 'true';
    app = await bootApp();
    stopConsumers = bootEventConsumers();
    await resetState();
  });
  after(async () => {
    delete process.env[CASH_CONFIRM_FLAG];
    stopConsumers();
    await app.close();
  });
  afterEach(async () => {
    await resetState();
  });

  it('confirmCash excludes commission already collected via the wallet', async () => {
    const w = await rideWorld(
      app,
      { customer: '+919876650020', driver: '+919876650021' },
      { driver: { paymentModel: 'COMMISSION', commissionWalletBalance: 100_000 } },
    );
    const requestId = await bookRideRequest(app, w, { distanceKm: 6, paymentMethod: 'CASH' });
    const rideId = await acceptRide(app, w, requestId);
    const ride = await db().client.ride.findUniqueOrThrow({ where: { id: rideId } });
    const storedCommission = new Decimal(ride.commissionAmount!);
    const walletBefore = (await commissionWallet(w.driverId)).balance;

    const fare = await finishRide(app, w, rideId, { distanceKm: 6, durationMin: 12 });

    // Completion still deducts the wallet unconditionally, regardless of the
    // flag — but with the flag on, the ride completes PENDING and no
    // cash-settlement ledger posting has happened yet.
    assert.equal(
      (await commissionWallet(w.driverId)).balance.toFixed(2),
      walletBefore.sub(storedCommission).toFixed(2),
    );
    assert.equal(
      (await accountBalance('PLATFORM_COMMISSION', { rideId })).toFixed(2),
      storedCommission.toFixed(2),
    );

    const confirmed = await app.inject({
      method: 'POST',
      url: `/api/v1/rides/${rideId}/payment/confirm-cash`,
      headers: { ...w.driver.authHeader, 'idempotency-key': randomUUID() },
      payload: {},
    });
    assert.equal(confirmed.statusCode, 200, confirmed.payload);

    // The wallet must not move a second time — confirmCash only posts the
    // ledger/settlement-wallet debt, it never touches the Commission Wallet.
    assert.equal(
      (await commissionWallet(w.driverId)).balance.toFixed(2),
      walletBefore.sub(storedCommission).toFixed(2),
    );
    assert.equal(
      (await accountBalance('PLATFORM_COMMISSION', { rideId })).toFixed(2),
      storedCommission.toFixed(2),
      'confirmCash must not add a second PLATFORM_COMMISSION credit for this ride',
    );
    const driverPayableTotal = await accountBalance('DRIVER_PAYABLE', {
      accountRefId: w.driverId,
      rideId,
    });
    assert.equal(
      driverPayableTotal.toFixed(2),
      fare.totalFare.sub(fare.driverEarning).sub(fare.platformCommission).neg().toFixed(2),
      'confirmCash still recovers tax + platform fee, minus the commission already collected',
    );
  });
});

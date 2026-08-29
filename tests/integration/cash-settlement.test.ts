import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, bootEventConsumers, db, drainOutbox, resetState } from './helpers/harness.js';
import { accountBalance, completeRide, rideWorld, type RideWorld } from './helpers/ride-flow.js';
import { container } from '../../src/core/di.js';
import { Decimal } from '../../src/modules/payments/types/index.js';
import type { Unsubscribe } from '../../src/core/events/index.js';
import type { CollectionSweepJob } from '../../src/modules/payments/jobs/collection-sweep.job.js';
import type { RideCollectionService } from '../../src/modules/payments/services/collection/collection.service.js';
import type { SettlementService } from '../../src/modules/payments/services/settlement/settlement.service.js';
import { paymentConfig } from '../../src/config/payment/payment.config.js';

const FLAG = 'PAYMENT_CASH_CONFIRMATION_REQUIRED';
/// FR-006. What a cash driver owes back: everything they collected that is not
/// their earning — the commission **plus** the tax and the platform fee they are
/// also holding. These assertions used to read `platformCommission`, which was
/// the same number only because commission was levied on the whole total and so
/// absorbed the other two.
function platformShareOf(fare: { totalFare: Decimal; driverEarning: Decimal }): Decimal {
  return new Decimal(fare.totalFare).sub(new Decimal(fare.driverEarning));
}

const CUSTOMER = '+919876606001';
const DRIVER = '+919876606002';

const sweep = () => container.resolve<CollectionSweepJob>('collectionSweepJob');
const collection = () => container.resolve<RideCollectionService>('rideCollectionService');
const settlements = () => container.resolve<SettlementService>('settlementService');

function confirmCash(app: FastifyInstance, w: RideWorld, rideId: string, key = randomUUID()) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/rides/${rideId}/payment/confirm-cash`,
    headers: { ...w.driver.authHeader, 'idempotency-key': key },
    payload: {},
  });
}

/// Pushes a ride's completion back past the grace period, so the sweep sees it
/// as unacknowledged without the test having to wait an hour.
async function ageBeyondGrace(rideId: string): Promise<void> {
  const past = new Date(Date.now() - (paymentConfig.cashConfirmGraceSeconds + 60) * 1000);
  await db().client.ride.update({ where: { id: rideId }, data: { completedAt: past } });
}

describe('cash settlement with the flag OFF (integration)', () => {
  let app: FastifyInstance;
  let stopConsumers: Unsubscribe;

  before(async () => {
    delete process.env[FLAG];
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

  it('pays a cash ride at completion, exactly as before', async () => {
    const w = await rideWorld(app, { customer: CUSTOMER, driver: DRIVER });
    const { rideId, fare } = await completeRide(app, w, {
      distanceKm: 10,
      durationMin: 20,
      paymentMethod: 'CASH',
    });
    await drainOutbox();

    const ride = await db().client.ride.findUniqueOrThrow({ where: { id: rideId } });
    assert.equal(ride.paymentStatus, 'PAID');
    assert.equal(
      (await accountBalance('DRIVER_PAYABLE', { rideId })).toFixed(2),
      platformShareOf(fare).neg().toFixed(2),
      'the driver owes the whole platform share, not the commission alone',
    );
  });

  it('does not expose the confirmation route at all', async () => {
    const w = await rideWorld(app, { customer: CUSTOMER, driver: DRIVER });
    const { rideId } = await completeRide(app, w, {
      distanceKm: 6,
      durationMin: 14,
      paymentMethod: 'CASH',
    });

    const response = await confirmCash(app, w, rideId);
    // BD-5: not forbidden, not disabled -- absent. A registered route
    // answering 403 would still be reachable.
    assert.equal(response.statusCode, 404, response.payload);
  });

  it('leaves cash alone in the sweep', async () => {
    const w = await rideWorld(app, { customer: CUSTOMER, driver: DRIVER });
    const { rideId } = await completeRide(app, w, {
      distanceKm: 6,
      durationMin: 14,
      paymentMethod: 'CASH',
    });
    await drainOutbox();
    await ageBeyondGrace(rideId);

    const report = await sweep().run();
    assert.equal(report.cashResolved, 0);
  });
});

describe('cash settlement with the flag ON (integration)', () => {
  let app: FastifyInstance;
  let stopConsumers: Unsubscribe;

  before(async () => {
    process.env[FLAG] = 'true';
    app = await bootApp();
    stopConsumers = bootEventConsumers();
    await resetState();
  });
  after(async () => {
    stopConsumers();
    await app.close();
    delete process.env[FLAG];
  });
  afterEach(async () => {
    await resetState();
  });

  const world = () => rideWorld(app, { customer: CUSTOMER, driver: DRIVER });

  async function cashRide(w: RideWorld) {
    const ride = await completeRide(app, w, {
      distanceKm: 10,
      durationMin: 20,
      paymentMethod: 'CASH',
    });
    await drainOutbox();
    const row = await db().client.ride.findUniqueOrThrow({ where: { id: ride.rideId } });
    assert.equal(row.paymentStatus, 'PENDING', 'cash now waits to be acknowledged');
    return ride;
  }

  function walletOf(driverId: string) {
    return db().client.driverWallet.findUnique({ where: { driverId } });
  }

  // T055 -- driver confirmation

  it('books the commission against the driver when they confirm', async () => {
    const w = await world();
    const { rideId, fare } = await cashRide(w);
    assert.equal(
      (await accountBalance('PLATFORM_COMMISSION', { rideId })).toFixed(2),
      '0.00',
      'nothing is recognised before the acknowledgement',
    );

    const response = await confirmCash(app, w, rideId);
    assert.equal(response.statusCode, 200, response.payload);
    assert.equal(response.json().data.collectionState, 'PAID');

    const ride = await db().client.ride.findUniqueOrThrow({ where: { id: rideId } });
    assert.equal(ride.paymentStatus, 'PAID');

    const wallet = await walletOf(w.driverId);
    assert.equal(
      wallet?.balance.toFixed(2),
      platformShareOf(fare).neg().toFixed(2),
      'the driver now owes the platform share -- a negative balance is the debt',
    );
    const txns = await db().client.driverWalletTransaction.findMany({
      where: { driverId: w.driverId },
    });
    assert.equal(txns.length, 1);
    assert.equal(
      txns[0]?.amount.toFixed(2),
      platformShareOf(fare).neg().toFixed(2),
      'recorded negative',
    );
    assert.equal(
      (await accountBalance('PLATFORM_COMMISSION', { rideId })).toFixed(2),
      new Decimal(fare.platformCommission).toFixed(2),
    );
  });

  it('refuses a driver who was not on the ride', async () => {
    const w = await world();
    const { rideId } = await cashRide(w);
    const other = await rideWorld(app, {
      customer: '+919876606003',
      driver: '+919876606004',
    });

    const response = await confirmCash(app, other, rideId);
    assert.equal(response.statusCode, 404, response.payload);

    const ride = await db().client.ride.findUniqueOrThrow({ where: { id: rideId } });
    assert.equal(ride.paymentStatus, 'PENDING', 'nothing moved');
    assert.equal(await walletOf(other.driverId), null, 'and nobody else was charged');
  });

  // T056 -- idempotent confirmation

  it('replays a repeated confirmation key without booking the commission twice', async () => {
    const w = await world();
    const { rideId, fare } = await cashRide(w);

    const key = randomUUID();
    const first = await confirmCash(app, w, rideId, key);
    const second = await confirmCash(app, w, rideId, key);

    assert.equal(first.statusCode, 200, first.payload);
    assert.equal(second.statusCode, 200, second.payload);
    assert.deepEqual(first.json().data, second.json().data);

    assert.equal(
      (await walletOf(w.driverId))?.balance.toFixed(2),
      platformShareOf(fare).neg().toFixed(2),
      'charged once',
    );
    assert.equal(
      await db().client.ridePayment.count({ where: { rideId, status: 'SUCCEEDED' } }),
      1,
    );
  });

  // T057 -- Race 9: manual confirmation against automatic resolution

  it('resolves once when the sweep and the driver act at the same instant', async () => {
    const w = await world();
    const { rideId, fare } = await cashRide(w);
    await ageBeyondGrace(rideId);

    await Promise.all([
      sweep().run(),
      confirmCash(app, w, rideId),
      collection().confirmCash(rideId, { automatic: true }),
    ]);

    assert.equal(
      await db().client.ridePayment.count({ where: { rideId, status: 'SUCCEEDED' } }),
      1,
      'one payment row',
    );
    assert.equal(
      await db().client.driverWalletTransaction.count({ where: { driverId: w.driverId } }),
      1,
      'one commission debit',
    );
    assert.equal(
      (await accountBalance('PLATFORM_COMMISSION', { rideId })).toFixed(2),
      new Decimal(fare.platformCommission).toFixed(2),
      'commission recognised once',
    );
    assert.equal(
      (await accountBalance('DRIVER_PAYABLE', { rideId })).toFixed(2),
      platformShareOf(fare).neg().toFixed(2),
      'and the driver debited once',
    );
  });

  // T058 -- every BD-6 precondition, one test per condition

  it('resolves a cash ride automatically once the grace period has passed', async () => {
    const w = await world();
    const { rideId, fare } = await cashRide(w);
    await ageBeyondGrace(rideId);

    const report = await sweep().run();

    assert.equal(report.cashResolved, 1, JSON.stringify(report));
    const ride = await db().client.ride.findUniqueOrThrow({ where: { id: rideId } });
    assert.equal(ride.paymentStatus, 'PAID');
    assert.equal(
      (await walletOf(w.driverId))?.balance.toFixed(2),
      platformShareOf(fare).neg().toFixed(2),
    );

    // An auditor has to be able to tell a timeout from an acknowledgement.
    const entry = await db().client.paymentLedgerEntry.findFirst({
      where: { referenceId: rideId, account: 'PLATFORM_COMMISSION' },
    });
    assert.match(String(entry?.description), /automatically after the grace period/);
  });

  it('leaves a ride still inside its grace period alone', async () => {
    const w = await world();
    const { rideId } = await cashRide(w);

    const report = await sweep().run();

    assert.equal(report.cashResolved, 0);
    const ride = await db().client.ride.findUniqueOrThrow({ where: { id: rideId } });
    assert.equal(ride.paymentStatus, 'PENDING');
  });

  it('leaves a cancelled ride, an in-progress ride and a non-cash ride alone', async () => {
    const w = await world();
    // All three rides are booked first: flipping one to IN_PROGRESS before the
    // others exist would make the customer's next booking 409.
    const inProgress = await cashRide(w);
    const cancelled = await cashRide(w);
    const card = await completeRide(app, w, {
      distanceKm: 7,
      durationMin: 15,
      paymentMethod: 'CARD',
    });
    for (const rideId of [inProgress.rideId, cancelled.rideId, card.rideId]) {
      await ageBeyondGrace(rideId);
    }
    await db().client.ride.update({
      where: { id: inProgress.rideId },
      data: { status: 'IN_PROGRESS' },
    });
    await db().client.ride.update({
      where: { id: cancelled.rideId },
      data: { status: 'CANCELLED_BY_CUSTOMER' },
    });

    const report = await sweep().run();

    assert.equal(report.cashResolved, 0, 'no cash resolution for any of the three');
    for (const rideId of [inProgress.rideId, cancelled.rideId]) {
      assert.equal(
        await db().client.ridePayment.count({ where: { rideId, status: 'SUCCEEDED' } }),
        0,
      );
    }
  });

  it('leaves an already-paid ride and one with a successful payment row alone', async () => {
    const w = await world();
    const paid = await cashRide(w);
    await confirmCash(app, w, paid.rideId);
    await ageBeyondGrace(paid.rideId);

    const walletBefore = await walletOf(w.driverId);
    const report = await sweep().run();

    assert.equal(report.cashResolved, 0);
    assert.equal(
      await db().client.ridePayment.count({ where: { rideId: paid.rideId, status: 'SUCCEEDED' } }),
      1,
      'still one payment row',
    );
    assert.equal(
      (await walletOf(w.driverId))?.balance.toFixed(2),
      walletBefore?.balance.toFixed(2),
      'and the driver is not charged twice',
    );
  });

  // T059 -- the commission carries forward and is recovered exactly once

  it('carries a negative period into the next settlement and recovers it once', async () => {
    const w = await world();
    const cash = await cashRide(w);
    await confirmCash(app, w, cash.rideId);
    const owed = platformShareOf(cash.fare);

    const day = 24 * 60 * 60 * 1000;
    const firstPeriod = { periodStart: new Date(Date.now() - day), periodEnd: new Date() };
    const first = await settlements().calculateSettlement({ driverId: w.driverId, ...firstPeriod });

    // The commission is already out of the wallet, so it must not be netted a
    // second time here -- the wallet is what carries the debt.
    assert.equal(new Decimal(first.commission).toFixed(2), '0.00', 'already recovered');
    assert.equal(new Decimal(first.netPayable).toFixed(2), '0.00');
    assert.equal(
      (await walletOf(w.driverId))?.balance.toFixed(2),
      owed.neg().toFixed(2),
      'the debt still sits on the wallet',
    );

    // A later period where the driver earns properly.
    const card = await completeRide(app, w, {
      distanceKm: 12,
      durationMin: 25,
      paymentMethod: 'CARD',
    });
    await drainOutbox();

    const second = await settlements().calculateSettlement({
      driverId: w.driverId,
      periodStart: new Date(Date.now() - 60_000),
      periodEnd: new Date(Date.now() + day),
    });
    assert.equal(
      new Decimal(second.netPayable).toFixed(2),
      new Decimal(card.fare.driverEarning).toFixed(2),
      'the period pays what the ride earned',
    );

    // Debt recovered equals debt carried: the wallet started the period at
    // -commission and the payout brings it to earnings - commission.
    assert.equal(
      (await walletOf(w.driverId))?.balance.toFixed(2),
      new Decimal(card.fare.driverEarning).sub(owed).toFixed(2),
      'recovered exactly once',
    );
  });

  it('shows the driver what they owe, and never a blocked flag', async () => {
    const w = await world();
    const cash = await cashRide(w);
    await confirmCash(app, w, cash.rideId);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/payments/me/debt',
      headers: w.driver.authHeader,
    });
    assert.equal(response.statusCode, 200, response.payload);
    const body = response.json().data;

    assert.equal(
      new Decimal(body.driver.outstanding).toFixed(2),
      platformShareOf(cash.fare).toFixed(2),
    );
    // BD-3 approved no driver blocking, so there is nothing here to enforce.
    assert.ok(!('limit' in body.driver), 'no limit for a driver');
    assert.ok(!('blocked' in body.driver), 'and no blocked flag');
    assert.equal(body.rider.blocked, false, 'the rider half is still reported');
  });
});

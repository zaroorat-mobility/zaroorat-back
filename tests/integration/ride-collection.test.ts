import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, bootEventConsumers, db, drainOutbox, resetState } from './helpers/harness.js';
import {
  accountBalance,
  completeRide,
  fundWallet,
  replayOutboxEvent,
  rideWorld,
  type RideWorld,
} from './helpers/ride-flow.js';
import { container } from '../../src/core/di.js';
import { Decimal } from '../../src/modules/payments/types/index.js';
import type { Unsubscribe } from '../../src/core/events/index.js';
import type { RideCollectionService } from '../../src/modules/payments/services/collection/collection.service.js';
import type { PaymentGatewayProvider } from '../../src/modules/payments/services/gateway/gateway.provider.js';
import type { CollectionSweepJob } from '../../src/modules/payments/jobs/collection-sweep.job.js';
import { paymentConfig } from '../../src/config/payment/payment.config.js';

const CUSTOMER = '+919876604001';
const DRIVER = '+919876604002';

describe('ride collection (integration, real HTTP)', () => {
  let app: FastifyInstance;
  let stopConsumers: Unsubscribe;
  let restoreGateway: (() => void) | null = null;

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
    restoreGateway?.();
    restoreGateway = null;
    await db().client.$executeRawUnsafe('TRUNCATE "gateway_events" CASCADE');
    await resetState();
  });

  const world = (): Promise<RideWorld> => rideWorld(app, { customer: CUSTOMER, driver: DRIVER });
  const collection = () => container.resolve<RideCollectionService>('rideCollectionService');

  /// Makes the gateway decline, the way the harness pins the OTP generator:
  /// the provider is a container singleton, so the method is swapped on the
  /// resolved instance rather than on the registration.
  function declineGateway(): void {
    const gateway = container.resolve<PaymentGatewayProvider>(
      'paymentGatewayProvider',
    ) as unknown as {
      confirmIntent: (id: string) => Promise<{ gatewayIntentId: string; status: string }>;
    };
    const original = gateway.confirmIntent.bind(gateway);
    gateway.confirmIntent = async (id: string) => ({ gatewayIntentId: id, status: 'FAILED' });
    restoreGateway = () => {
      gateway.confirmIntent = original;
    };
  }

  function attempts(rideId: string) {
    return db().client.ridePayment.findMany({ where: { rideId }, orderBy: { createdAt: 'asc' } });
  }

  function walletOf(userId: string) {
    return db().client.customerWallet.findUniqueOrThrow({ where: { userId } });
  }

  async function paymentView(w: RideWorld, rideId: string) {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/rides/${rideId}/payment`,
      headers: w.customer.authHeader,
    });
    assert.equal(response.statusCode, 200, response.payload);
    return response.json().data;
  }

  // T034 -- wallet happy path

  it('charges a wallet ride to the wallet, exactly once', async () => {
    const w = await world();
    await fundWallet(app, w.customer, 2000);
    const { rideId, fare } = await completeRide(app, w, {
      distanceKm: 8,
      durationMin: 18,
      paymentMethod: 'WALLET',
    });
    await drainOutbox();

    const rows = await attempts(rideId);
    assert.equal(rows.length, 1, 'one attempt row');
    assert.equal(rows[0]?.status, 'SUCCEEDED');
    assert.equal(
      new Decimal(rows[0]!.amount).toFixed(2),
      new Decimal(fare.totalFare).toFixed(2),
      'charged the fare the server priced, never a recomputation',
    );

    const wallet = await walletOf(w.customer.userId);
    assert.equal(
      wallet.balance.toFixed(2),
      new Decimal(2000).sub(new Decimal(fare.totalFare)).toFixed(2),
    );

    const walletTxns = await db().client.customerWalletTransaction.findMany({
      where: { userId: w.customer.userId },
      orderBy: { createdAt: 'asc' },
    });
    assert.equal(
      walletTxns.at(-1)?.amount.toFixed(2),
      new Decimal(fare.totalFare).neg().toFixed(2),
      'the spend is recorded negative',
    );

    const entries = await db().client.paymentLedgerEntry.findMany({
      where: { referenceType: 'RIDE', referenceId: rideId },
    });
    const debits = entries
      .filter((e) => e.direction === 'DEBIT')
      .reduce((s, e) => s.add(e.amount), new Decimal(0));
    const credits = entries
      .filter((e) => e.direction === 'CREDIT')
      .reduce((s, e) => s.add(e.amount), new Decimal(0));
    assert.equal(debits.toFixed(2), credits.toFixed(2), 'the group sums to zero');
    assert.equal(
      entries.find((e) => e.direction === 'DEBIT')?.account,
      'CUSTOMER_WALLET',
      'a wallet ride is funded from the wallet',
    );

    const ride = await db().client.ride.findUniqueOrThrow({ where: { id: rideId } });
    assert.equal(ride.paymentStatus, 'PAID');
    assert.equal((await paymentView(w, rideId)).collectionState, 'PAID');
  });

  // T035 -- Race 12: the same completion delivered twice

  it('does not charge twice when the same completion is delivered again', async () => {
    const w = await world();
    await fundWallet(app, w.customer, 2000);
    const { rideId, fare } = await completeRide(app, w, {
      distanceKm: 6,
      durationMin: 14,
      paymentMethod: 'WALLET',
    });
    await drainOutbox();
    const afterFirst = await walletOf(w.customer.userId);

    await replayOutboxEvent('ride.completed');
    await drainOutbox();

    assert.equal((await attempts(rideId)).length, 1, 'still one attempt row');
    assert.equal(
      (await walletOf(w.customer.userId)).balance.toFixed(2),
      afterFirst.balance.toFixed(2),
      'balance unmoved',
    );
    assert.equal(
      (await accountBalance('DRIVER_PAYABLE', { rideId })).toFixed(2),
      new Decimal(fare.driverEarning).toFixed(2),
      'the driver is credited once, not twice',
    );
  });

  // T036 -- a card ride never touches the wallet

  it('funds a card ride from GATEWAY_CLEARING and leaves the wallet alone', async () => {
    const w = await world();
    await fundWallet(app, w.customer, 500);
    const before = await walletOf(w.customer.userId);

    const { rideId, fare } = await completeRide(app, w, { distanceKm: 9, durationMin: 20 });
    await drainOutbox();

    const entries = await db().client.paymentLedgerEntry.findMany({
      where: { referenceType: 'RIDE', referenceId: rideId },
    });
    const debit = entries.find((e) => e.direction === 'DEBIT');
    assert.equal(debit?.account, 'GATEWAY_CLEARING');
    assert.equal(new Decimal(debit!.amount).toFixed(2), new Decimal(fare.totalFare).toFixed(2));

    assert.equal(
      (await walletOf(w.customer.userId)).balance.toFixed(2),
      before.balance.toFixed(2),
      'the wallet is untouched',
    );
    assert.equal(
      (await accountBalance('CUSTOMER_WALLET', { rideId })).toFixed(2),
      '0.00',
      'and so is its ledger position',
    );
  });

  // T037 -- RT-3: the amount is the server's, not the client's

  it('ignores a client-supplied amount and a client-created intent', async () => {
    const w = await world();
    await fundWallet(app, w.customer, 3000);

    // A rider raising their own 1-rupee intent, and trying to name the ride it
    // settles. The schema no longer accepts rideId at all, so this cannot even
    // be expressed -- which is the point of FR-012.
    const intent = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/intents',
      headers: { ...w.customer.authHeader, 'idempotency-key': `${Date.now()}-cheat` },
      payload: { amount: 1, methodType: 'CARD', rideId: '00000000-0000-4000-8000-000000000000' },
    });
    assert.equal(intent.statusCode, 200, intent.payload);
    assert.equal(intent.json().data.rideId, null, 'a client cannot bind a payment to a ride');

    const { rideId, fare } = await completeRide(app, w, {
      distanceKm: 11,
      durationMin: 24,
      paymentMethod: 'WALLET',
    });
    // The retry route takes no amount either; anything sent is ignored.
    await drainOutbox();

    const rows = await attempts(rideId);
    assert.equal(
      new Decimal(rows[0]!.amount).toFixed(2),
      new Decimal(fare.totalFare).toFixed(2),
      'the charge is the priced fare, not the 1 rupee the client asked for',
    );
    assert.ok(new Decimal(fare.totalFare).gt(1));
  });

  // T038 -- decline leaves the ride complete, the driver free, and the rider owing

  it('leaves the ride COMPLETED and the driver ONLINE when collection declines', async () => {
    const w = await world();
    declineGateway();

    const { rideId } = await completeRide(app, w, { distanceKm: 7, durationMin: 15 });
    await drainOutbox();

    const ride = await db().client.ride.findUniqueOrThrow({ where: { id: rideId } });
    assert.equal(ride.status, 'COMPLETED', 'a decline cannot un-complete a driven ride');
    assert.equal(ride.paymentStatus, 'PENDING', 'the obligation is still open');

    const status = await db().client.driverOnlineStatus.findUnique({
      where: { driverId: w.driverId },
    });
    assert.equal(status?.status, 'ONLINE', 'the driver is free to take the next ride');

    const rows = await attempts(rideId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.status, 'FAILED');

    const view = await paymentView(w, rideId);
    assert.equal(view.collectionState, 'RETRYING', 'budget remains');
    assert.notEqual(view.collectionState, 'FAILED', 'FAILED never reaches a client');
    assert.equal(view.amountOwed, 0, 'nothing is owed while retries remain');
  });

  it('turns the obligation into a receivable once the attempt budget runs out', async () => {
    const w = await world();
    declineGateway();

    const { rideId, fare } = await completeRide(app, w, { distanceKm: 7, durationMin: 15 });
    await drainOutbox();

    // Exhaust the configured budget. The first attempt was the consumer's.
    for (let i = 1; i < paymentConfig.collectionMaxAttempts; i++) {
      assert.equal(
        await collection().collect(rideId),
        i === paymentConfig.collectionMaxAttempts - 1 ? 'RECEIVABLE' : 'RETRYING',
      );
    }

    const ride = await db().client.ride.findUniqueOrThrow({ where: { id: rideId } });
    assert.equal(ride.status, 'COMPLETED');
    assert.equal(ride.paymentStatus, 'FAILED', 'internally, the receivable state');

    const view = await paymentView(w, rideId);
    assert.equal(view.collectionState, 'UNPAID', 'standing debt, not a failed attempt');
    assert.equal(
      new Decimal(view.amountOwed).toFixed(2),
      new Decimal(fare.totalFare).toFixed(2),
      'the rider owes the fare',
    );

    // BD-1 option C: an uncollected fare is an asset, not a loss, and the
    // driver is paid regardless -- they drove the trip.
    assert.equal(
      (await accountBalance('CUSTOMER_RECEIVABLE', { rideId })).toFixed(2),
      new Decimal(fare.totalFare).neg().toFixed(2),
      'the receivable is a debit balance',
    );
    assert.equal(
      (await accountBalance('DRIVER_PAYABLE', { rideId })).toFixed(2),
      new Decimal(fare.driverEarning).toFixed(2),
    );
    assert.equal(
      (await accountBalance('BAD_DEBT_EXPENSE', { rideId })).toFixed(2),
      '0.00',
      'bad debt is recognised at write-off, never when the receivable is created',
    );
  });

  // T039 -- Races 4, 5 and 11: only one of any interleaving may charge

  // The sweep is the safety net for everything the consumer could not finish.

  it('collects a ride whose completion event was never delivered', async () => {
    const w = await world();
    await fundWallet(app, w.customer, 2000);
    const { rideId, fare } = await completeRide(app, w, {
      distanceKm: 8,
      durationMin: 18,
      paymentMethod: 'WALLET',
    });
    // Deliberately no drainOutbox: this is the relay dying before delivery.
    assert.equal((await attempts(rideId)).length, 0, 'precondition: nothing collected yet');

    const report = await container.resolve<CollectionSweepJob>('collectionSweepJob').run();

    assert.equal(report.collected, 1, JSON.stringify(report));
    assert.equal(
      (await walletOf(w.customer.userId)).balance.toFixed(2),
      new Decimal(2000).sub(new Decimal(fare.totalFare)).toFixed(2),
    );
  });

  it('leaves an already-settled ride alone on the next sweep', async () => {
    const w = await world();
    await fundWallet(app, w.customer, 2000);
    const { rideId } = await completeRide(app, w, {
      distanceKm: 5,
      durationMin: 12,
      paymentMethod: 'WALLET',
    });
    await drainOutbox();
    const settled = await walletOf(w.customer.userId);

    const report = await container.resolve<CollectionSweepJob>('collectionSweepJob').run();

    assert.equal(report.scanned, 0, 'a PAID ride no longer matches the query');
    assert.equal((await attempts(rideId)).length, 1);
    assert.equal(
      (await walletOf(w.customer.userId)).balance.toFixed(2),
      settled.balance.toFixed(2),
    );
  });

  it('charges once when several collections run at the same instant', async () => {
    const w = await world();
    await fundWallet(app, w.customer, 5000);
    const { rideId, fare } = await completeRide(app, w, {
      distanceKm: 10,
      durationMin: 22,
      paymentMethod: 'WALLET',
    });

    const results = await Promise.all([
      collection().collect(rideId),
      collection().collect(rideId),
      collection().collect(rideId),
      drainOutbox(),
    ]);

    assert.equal(
      results.filter((r) => r === 'COLLECTED').length,
      1,
      `exactly one winner, got ${JSON.stringify(results)}`,
    );
    const succeeded = (await attempts(rideId)).filter((a) => a.status === 'SUCCEEDED');
    assert.equal(succeeded.length, 1, 'one SUCCEEDED row -- the partial unique index holds');
    assert.equal(
      (await walletOf(w.customer.userId)).balance.toFixed(2),
      new Decimal(5000).sub(new Decimal(fare.totalFare)).toFixed(2),
      'charged once',
    );
  });

  // Invariant 5 -- the ledger never claims a payment that has not happened

  it('posts nothing to the ledger for a ride that has not been collected yet', async () => {
    const w = await world();
    await fundWallet(app, w.customer, 2000);
    const { rideId } = await completeRide(app, w, {
      distanceKm: 8,
      durationMin: 18,
      paymentMethod: 'WALLET',
    });
    // Deliberately no drainOutbox: the ride is complete, the fare is priced,
    // and nobody has paid. This used to post a wallet debit, driver earnings
    // and platform commission right here (FR-038).
    const entries = await db().client.paymentLedgerEntry.findMany({
      where: { referenceType: 'RIDE', referenceId: rideId },
    });
    assert.equal(entries.length, 0, 'no entry asserts a payment nobody has made');

    const succeeded = await db().client.ridePayment.count({
      where: { rideId, status: 'SUCCEEDED' },
    });
    assert.equal(succeeded, 0, 'and there is no payment record to justify one');
  });
});

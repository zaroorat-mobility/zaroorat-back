import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, bootEventConsumers, db, drainOutbox, resetState } from './helpers/harness.js';
import {
  accountBalance,
  completeRide,
  fundWallet,
  rideWorld,
  type RideWorld,
} from './helpers/ride-flow.js';
import { container } from '../../src/core/di.js';
import { Decimal } from '../../src/modules/payments/types/index.js';
import type { Unsubscribe } from '../../src/core/events/index.js';
import type { RideCollectionService } from '../../src/modules/payments/services/collection/collection.service.js';
import type { PaymentGatewayProvider } from '../../src/modules/payments/services/gateway/gateway.provider.js';
import type { WriteOffService } from '../../src/modules/payments/services/writeoff/writeoff.service.js';
import type { ReceivableWriteOffJob } from '../../src/modules/payments/jobs/receivable-writeoff.job.js';
import type { DebtService } from '../../src/modules/payments/services/debt/debt.service.js';
import { paymentConfig } from '../../src/config/payment/payment.config.js';

const CUSTOMER = '+919876605001';
const DRIVER = '+919876605002';

describe('customer receivable (integration, real HTTP)', () => {
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
  const writeOffs = () => container.resolve<WriteOffService>('writeOffService');
  const writeOffJob = () => container.resolve<ReceivableWriteOffJob>('receivableWriteOffJob');
  const debts = () => container.resolve<DebtService>('debtService');

  /// Ages a receivable past the write-off window without waiting 90 days.
  async function ageBeyondWriteOff(rideId: string): Promise<void> {
    const past = new Date(Date.now() - (paymentConfig.receivableWriteOffDays + 1) * 86_400_000);
    await db().client.ride.update({ where: { id: rideId }, data: { completedAt: past } });
  }

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

  /// A completed ride whose collection budget is spent: an open receivable.
  async function rideWithOpenReceivable(w: RideWorld) {
    declineGateway();
    const ride = await completeRide(app, w, {
      distanceKm: 9,
      durationMin: 20,
      paymentMethod: 'WALLET',
    });
    await drainOutbox();
    for (let i = 1; i < paymentConfig.collectionMaxAttempts; i++) {
      await collection().collect(ride.rideId);
    }
    const row = await db().client.ride.findUniqueOrThrow({ where: { id: ride.rideId } });
    assert.equal(row.paymentStatus, 'FAILED', 'precondition: the receivable is open');
    restoreGateway?.();
    restoreGateway = null;
    return ride;
  }

  function retry(w: RideWorld, rideId: string) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/rides/${rideId}/payment/retry`,
      headers: { ...w.customer.authHeader, 'idempotency-key': randomUUID() },
      payload: {},
    });
  }

  // T040 -- Race 6, and the highest-value assertion in the feature.

  it('clears the receivable only, without paying the driver twice', async () => {
    const w = await world();
    const { rideId, fare } = await rideWithOpenReceivable(w);

    const payableBefore = await accountBalance('DRIVER_PAYABLE', { rideId });
    const commissionBefore = await accountBalance('PLATFORM_COMMISSION', { rideId });
    assert.equal(
      payableBefore.toFixed(2),
      new Decimal(fare.driverEarning).toFixed(2),
      'precondition: earnings were recognised when the receivable was created',
    );

    await fundWallet(app, w.customer, 5000);
    const settled = await retry(w, rideId);
    assert.equal(settled.statusCode, 200, settled.payload);
    assert.equal(settled.json().data.collectionState, 'PAID');
    assert.equal(settled.json().data.amountOwed, 0);

    // The whole point of splitting transition 7: posting the full group here
    // would credit these a second time and double-count one ride's earnings
    // and revenue.
    assert.equal(
      (await accountBalance('DRIVER_PAYABLE', { rideId })).toFixed(2),
      payableBefore.toFixed(2),
      'the driver is not paid twice',
    );
    assert.equal(
      (await accountBalance('PLATFORM_COMMISSION', { rideId })).toFixed(2),
      commissionBefore.toFixed(2),
      'the commission is not recognised twice',
    );
    assert.equal(
      (await accountBalance('CUSTOMER_RECEIVABLE', { rideId })).toFixed(2),
      '0.00',
      'and the receivable is cleared',
    );
    assert.equal(
      (await accountBalance('CUSTOMER_WALLET', { rideId })).toFixed(2),
      new Decimal(fare.totalFare).neg().toFixed(2),
      'the money came out of the wallet',
    );

    const ride = await db().client.ride.findUniqueOrThrow({ where: { id: rideId } });
    assert.equal(ride.paymentStatus, 'PAID');
  });

  it('books every ledger group in the chain to zero', async () => {
    const w = await world();
    const { rideId } = await rideWithOpenReceivable(w);
    await fundWallet(app, w.customer, 5000);
    await retry(w, rideId);

    const entries = await db().client.paymentLedgerEntry.findMany({
      where: { referenceType: 'RIDE', referenceId: rideId },
    });
    const groups = new Map<string, Decimal>();
    for (const entry of entries) {
      const signed = entry.direction === 'DEBIT' ? entry.amount : entry.amount.neg();
      groups.set(entry.entryGroup, (groups.get(entry.entryGroup) ?? new Decimal(0)).add(signed));
    }
    assert.equal(groups.size, 2, 'the receivable group and the settlement group');
    for (const [group, net] of groups) {
      assert.equal(net.toFixed(2), '0.00', `group ${group} must balance`);
    }
  });

  it('refuses to settle a ride that was written off, and one already paid', async () => {
    const w = await world();
    const { rideId, fare } = await rideWithOpenReceivable(w);
    await db().client.ridePayment.create({
      data: { rideId, amount: fare.totalFare, method: 'WALLET', status: 'WRITTEN_OFF' },
    });

    const refused = await retry(w, rideId);
    assert.equal(refused.statusCode, 409, refused.payload);
    assert.equal(refused.json().error.code, 'OBLIGATION_WRITTEN_OFF');

    const paid = await rideWorld(app, {
      customer: '+919876605005',
      driver: '+919876605006',
    });
    await fundWallet(app, paid.customer, 3000);
    const settledRide = await completeRide(app, paid, {
      distanceKm: 5,
      durationMin: 12,
      paymentMethod: 'WALLET',
    });
    await drainOutbox();
    const already = await retry(paid, settledRide.rideId);
    assert.equal(already.statusCode, 409, already.payload);
    assert.equal(already.json().error.code, 'COLLECTION_NOT_RETRYABLE');
  });

  it('reports a written-off receivable as owing nothing', async () => {
    const w = await world();
    const { rideId, fare } = await rideWithOpenReceivable(w);
    await db().client.ridePayment.create({
      data: { rideId, amount: fare.totalFare, method: 'WALLET', status: 'WRITTEN_OFF' },
    });

    const view = await app.inject({
      method: 'GET',
      url: `/api/v1/rides/${rideId}/payment`,
      headers: w.customer.authHeader,
    });
    assert.equal(view.json().data.collectionState, 'WRITTEN_OFF');
    assert.equal(view.json().data.amountOwed, 0, 'BD-1c closes the obligation');
  });

  it('hides a ride the caller is not party to behind a 404, not a 403', async () => {
    const w = await world();
    const { rideId } = await rideWithOpenReceivable(w);
    const stranger = await rideWorld(app, {
      customer: '+919876605003',
      driver: '+919876605004',
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/rides/${rideId}/payment`,
      headers: stranger.customer.authHeader,
    });
    assert.equal(response.statusCode, 404, response.payload);
    assert.equal(response.json().error.code, 'RIDE_PAYMENT_NOT_FOUND');
  });

  it('replays a repeated retry key without charging twice', async () => {
    const w = await world();
    const { rideId, fare } = await rideWithOpenReceivable(w);
    await fundWallet(app, w.customer, 5000);

    const key = randomUUID();
    const send = () =>
      app.inject({
        method: 'POST',
        url: `/api/v1/rides/${rideId}/payment/retry`,
        headers: { ...w.customer.authHeader, 'idempotency-key': key },
        payload: {},
      });
    const first = await send();
    const second = await send();

    assert.equal(first.statusCode, 200, first.payload);
    assert.equal(second.statusCode, 200, second.payload);
    assert.deepEqual(first.json().data, second.json().data);

    const wallet = await db().client.customerWallet.findUniqueOrThrow({
      where: { userId: w.customer.userId },
    });
    assert.equal(
      wallet.balance.toFixed(2),
      new Decimal(5000).sub(new Decimal(fare.totalFare)).toFixed(2),
      'charged once',
    );
  });

  // T074 -- Race 7: the write-off must happen once, and must lose to a late payment

  it('writes a receivable off once, however many times the sweep runs', async () => {
    const w = await world();
    const { rideId, fare } = await rideWithOpenReceivable(w);
    await ageBeyondWriteOff(rideId);

    const first = await writeOffJob().run();
    const second = await writeOffJob().run();

    assert.equal(first.writtenOff, 1, JSON.stringify(first));
    assert.equal(second.writtenOff, 0, 'the second sweep finds nothing left to do');
    assert.equal(
      await db().client.ridePayment.count({ where: { rideId, status: 'WRITTEN_OFF' } }),
      1,
      'one write-off row',
    );
    assert.equal(
      (await accountBalance('BAD_DEBT_EXPENSE', { rideId })).toFixed(2),
      new Decimal(fare.totalFare).neg().toFixed(2),
      'one bad-debt group -- a debit balance',
    );
    assert.equal(
      (await accountBalance('CUSTOMER_RECEIVABLE', { rideId })).toFixed(2),
      '0.00',
      'and the receivable is cleared',
    );
  });

  it('does not write off a debt the rider settles at the same moment', async () => {
    const w = await world();
    const { rideId } = await rideWithOpenReceivable(w);
    await ageBeyondWriteOff(rideId);
    await fundWallet(app, w.customer, 5000);

    await Promise.all([
      writeOffs().writeOff(rideId),
      collection().settleReceivable(rideId),
      writeOffs().writeOff(rideId),
    ]);

    const written = await db().client.ridePayment.count({
      where: { rideId, status: 'WRITTEN_OFF' },
    });
    const succeeded = await db().client.ridePayment.count({
      where: { rideId, status: 'SUCCEEDED' },
    });
    assert.equal(written + succeeded, 1, 'the obligation reaches exactly one outcome');
    // Whichever won, the receivable nets to zero and is never cleared twice.
    assert.equal((await accountBalance('CUSTOMER_RECEIVABLE', { rideId })).toFixed(2), '0.00');
  });

  it('recognises bad debt only at write-off, never when the receivable is created', async () => {
    const w = await world();
    const { rideId } = await rideWithOpenReceivable(w);

    assert.equal((await accountBalance('BAD_DEBT_EXPENSE', { rideId })).toFixed(2), '0.00');

    await ageBeyondWriteOff(rideId);
    await writeOffJob().run();

    assert.notEqual((await accountBalance('BAD_DEBT_EXPENSE', { rideId })).toFixed(2), '0.00');
  });

  it('leaves a receivable that is not old enough alone', async () => {
    const w = await world();
    const { rideId } = await rideWithOpenReceivable(w);

    const report = await writeOffJob().run();

    assert.equal(report.writtenOff, 0);
    assert.equal(
      await db().client.ridePayment.count({ where: { rideId, status: 'WRITTEN_OFF' } }),
      0,
    );
  });

  // T075 -- write-off closes the obligation

  it('closes the obligation to retries and to the debt threshold', async () => {
    const w = await world();
    const { rideId } = await rideWithOpenReceivable(w);
    const owedBefore = await debts().riderOutstanding(w.customer.userId);
    assert.ok(owedBefore.gt(0), 'precondition: the debt counts');

    await ageBeyondWriteOff(rideId);
    await writeOffJob().run();

    const view = await app.inject({
      method: 'GET',
      url: `/api/v1/rides/${rideId}/payment`,
      headers: w.customer.authHeader,
    });
    assert.equal(view.json().data.collectionState, 'WRITTEN_OFF');
    assert.equal(view.json().data.amountOwed, 0);

    const refused = await retry(w, rideId);
    assert.equal(refused.statusCode, 409, refused.payload);
    assert.equal(refused.json().error.code, 'OBLIGATION_WRITTEN_OFF');

    // BD-1c: written off means no longer outstanding, so it stops counting
    // against the rider for BD-2 as well. A debt that blocked someone forever
    // after the platform gave up on collecting it would be a different policy
    // from the one that was approved.
    assert.equal(
      (await debts().riderOutstanding(w.customer.userId)).toFixed(2),
      '0.00',
      'and no longer counts toward the threshold',
    );
  });

  // Invariant 9 -- the receivable account equals the fares actually outstanding

  it('keeps the CUSTOMER_RECEIVABLE position equal to the summed UNPAID fares', async () => {
    const w = await world();
    const first = await rideWithOpenReceivable(w);
    const second = await rideWithOpenReceivable(w);

    const outstanding = new Decimal(first.fare.totalFare).add(new Decimal(second.fare.totalFare));
    const position = await accountBalance('CUSTOMER_RECEIVABLE', {
      accountRefId: w.customer.userId,
    });
    assert.equal(
      position.neg().toFixed(2),
      outstanding.toFixed(2),
      'the asset the platform is carrying is exactly what its riders owe',
    );

    // And it follows both ways out of the state: settling clears one, writing
    // off clears the other, and neither leaves a residue behind.
    await fundWallet(app, w.customer, 20000);
    await retry(w, first.rideId);
    await ageBeyondWriteOff(second.rideId);
    await writeOffJob().run();

    assert.equal(
      (await accountBalance('CUSTOMER_RECEIVABLE', { accountRefId: w.customer.userId })).toFixed(2),
      '0.00',
      'nothing outstanding, nothing carried',
    );
  });
});

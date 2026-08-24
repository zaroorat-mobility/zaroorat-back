import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, bootEventConsumers, db, drainOutbox, resetState } from './helpers/harness.js';
import { completeRide, fundWallet, rideWorld } from './helpers/ride-flow.js';
import { container } from '../../src/core/di.js';
import { Decimal } from '../../src/modules/payments/types/index.js';
import type { Unsubscribe } from '../../src/core/events/index.js';
import type { ReconciliationJob } from '../../src/modules/payments/jobs/reconciliation.job.js';
import { paymentConfig } from '../../src/config/payment/payment.config.js';

const CUSTOMER = '+919876609001';
const DRIVER = '+919876609002';

describe('payment reconciliation (integration)', () => {
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

  const world = () => rideWorld(app, { customer: CUSTOMER, driver: DRIVER });
  const reconcile = () => container.resolve<ReconciliationJob>('reconciliationJob');

  it('matches a wallet whose balance agrees with both its history and the ledger', async () => {
    const w = await world();
    await fundWallet(app, w.customer, 1200);
    await completeRide(app, w, { distanceKm: 8, durationMin: 18, paymentMethod: 'WALLET' });
    await drainOutbox();

    const report = await reconcile().run();

    assert.ok(report.scanned > 0);
    assert.equal(report.mismatched, 0, JSON.stringify(report));
  });

  it('detects a customer balance that moved without the ledger', async () => {
    const w = await world();
    await fundWallet(app, w.customer, 1000);

    // The exact shape the wallet funding hole produced: a balance that rose
    // with nothing behind it.
    await db().client.customerWallet.update({
      where: { userId: w.customer.userId },
      data: { balance: new Decimal(9999) },
    });

    const report = await reconcile().run();
    assert.ok(report.mismatched >= 1, JSON.stringify(report));
  });

  it('detects a driver balance that diverges from its own transactions', async () => {
    const w = await world();
    await fundWallet(app, w.customer, 2000);
    await completeRide(app, w, { distanceKm: 9, durationMin: 20, paymentMethod: 'WALLET' });
    await drainOutbox();

    // Driver wallets were never reconciled at all before this: half the
    // balances on the platform had no check.
    await db().client.driverWallet.upsert({
      where: { driverId: w.driverId },
      create: { driverId: w.driverId, balance: new Decimal(500) },
      update: { balance: new Decimal(500) },
    });

    const report = await reconcile().run();

    const rows = await db().client.walletReconciliation.findMany({
      where: { walletType: 'DRIVER' },
    });
    assert.equal(rows.length, 1, 'the driver wallet is scanned');
    assert.equal(rows[0]?.status, 'MISMATCH');
    assert.ok(report.mismatched >= 1);
  });

  it('reports pre-cut-over divergence separately instead of as a live alarm', async () => {
    const w = await world();
    await fundWallet(app, w.customer, 800);

    // An entry from before the BD-7 boundary. It is uncorrectable, not
    // invisible: it must be counted, and counted apart from what the running
    // platform is accountable for.
    await db().client.paymentLedgerEntry.updateMany({
      where: { account: 'CUSTOMER_WALLET', accountRefId: w.customer.userId },
      data: { createdAt: new Date(paymentConfig.ledgerCutoverAt.getTime() - 86_400_000) },
    });

    const report = await reconcile().run();

    assert.ok(report.historicalMismatched >= 1, JSON.stringify(report));
    assert.equal(report.mismatched, 0, 'a known-bad history does not keep the live alarm red');
  });

  it('never rewrites a ledger entry (BD-7)', async () => {
    const w = await world();
    await fundWallet(app, w.customer, 650);
    await completeRide(app, w, { distanceKm: 7, durationMin: 16, paymentMethod: 'WALLET' });
    await drainOutbox();

    const before = await db().client.paymentLedgerEntry.findMany({ orderBy: { id: 'asc' } });
    assert.ok(before.length > 0);

    await reconcile().run();
    await reconcile().run();

    const after = await db().client.paymentLedgerEntry.findMany({ orderBy: { id: 'asc' } });
    assert.deepEqual(
      after.map((e) => ({ ...e, amount: e.amount.toFixed(2) })),
      before.map((e) => ({ ...e, amount: e.amount.toFixed(2) })),
      'every entry is byte-identical -- none updated, none deleted',
    );
  });
});

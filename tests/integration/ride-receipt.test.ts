import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, bootEventConsumers, db, drainOutbox, resetState } from './helpers/harness.js';
import { completeRide, fundWallet, rideWorld } from './helpers/ride-flow.js';
import type { LoggedInUser } from './helpers/harness.js';
import { container } from '../../src/core/di.js';
import { Decimal } from '../../src/modules/payments/types/index.js';
import type { Unsubscribe } from '../../src/core/events/index.js';
import type { RideCollectionService } from '../../src/modules/payments/services/collection/collection.service.js';
import type { PaymentGatewayProvider } from '../../src/modules/payments/services/gateway/gateway.provider.js';
import { paymentConfig } from '../../src/config/payment/payment.config.js';

const CUSTOMER = '+919876607001';
const DRIVER = '+919876607002';

describe('ride receipts (integration, real HTTP)', () => {
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

  const world = () => rideWorld(app, { customer: CUSTOMER, driver: DRIVER });
  const collection = () => container.resolve<RideCollectionService>('rideCollectionService');

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

  function fetchReceipt(rideId: string, user: LoggedInUser) {
    return app.inject({
      method: 'GET',
      url: `/api/v1/rides/${rideId}/receipt`,
      headers: user.authHeader,
    });
  }

  // T067 -- the receipt exists before anybody asks for it

  it('issues a receipt at the payment outcome, with no prior GET', async () => {
    const w = await world();
    await fundWallet(app, w.customer, 3000);
    const { rideId, fare } = await completeRide(app, w, {
      distanceKm: 9,
      durationMin: 20,
      paymentMethod: 'WALLET',
    });
    await drainOutbox();

    const stored = await db().client.rideReceipt.findUnique({ where: { rideId } });
    assert.ok(stored, 'the receipt is issued, not improvised on first read');

    const snapshot = stored.snapshotJson as unknown as {
      payment: { method: string; status: string; settledAt: string | null };
      fare: { totalFare: string } | null;
    };
    assert.equal(snapshot.payment.method, 'WALLET');
    assert.equal(snapshot.payment.status, 'PAID');
    assert.ok(snapshot.payment.settledAt, 'and records when it settled');
    assert.equal(
      new Decimal(snapshot.fare!.totalFare).toFixed(2),
      new Decimal(fare.totalFare).toFixed(2),
      'the itemised fare snapshot is untouched',
    );
  });

  it('issues one for a cash ride that collection never had to touch', async () => {
    const w = await world();
    const { rideId } = await completeRide(app, w, {
      distanceKm: 8,
      durationMin: 18,
      paymentMethod: 'CASH',
    });
    await drainOutbox();

    const stored = await db().client.rideReceipt.findUnique({ where: { rideId } });
    assert.ok(stored, 'a cash ride settled at completion still gets one');
    const snapshot = stored.snapshotJson as unknown as { payment: { status: string } };
    assert.equal(snapshot.payment.status, 'PAID');
  });

  it('issues one for a ride the rider never paid for', async () => {
    const w = await world();
    declineGateway();
    const { rideId } = await completeRide(app, w, { distanceKm: 7, durationMin: 16 });
    await drainOutbox();
    for (let i = 1; i < paymentConfig.collectionMaxAttempts; i++) {
      await collection().collect(rideId);
    }

    const stored = await db().client.rideReceipt.findUnique({ where: { rideId } });
    assert.ok(stored, 'the ride happened, so it has a record');
    const snapshot = stored.snapshotJson as unknown as { payment: { status: string } };
    assert.equal(snapshot.payment.status, 'UNPAID');
    assert.notEqual(snapshot.payment.status, 'FAILED', 'never the internal vocabulary');
  });

  // T068 -- immutability, and T071 -- who may read one

  it('returns identical content and the same number on every retrieval', async () => {
    const w = await world();
    await fundWallet(app, w.customer, 3000);
    const { rideId } = await completeRide(app, w, {
      distanceKm: 6,
      durationMin: 14,
      paymentMethod: 'WALLET',
    });
    await drainOutbox();

    const first = await fetchReceipt(rideId, w.customer);
    const second = await fetchReceipt(rideId, w.customer);

    assert.equal(first.statusCode, 200, first.payload);
    assert.deepEqual(first.json().data, second.json().data);
    assert.equal(first.json().data.receiptNumber, second.json().data.receiptNumber);
    assert.equal(await db().client.rideReceipt.count({ where: { rideId } }), 1);
  });

  it('is not rewritten when the obligation changes afterwards', async () => {
    const w = await world();
    declineGateway();
    const { rideId } = await completeRide(app, w, {
      distanceKm: 7,
      durationMin: 16,
      paymentMethod: 'WALLET',
    });
    await drainOutbox();
    for (let i = 1; i < paymentConfig.collectionMaxAttempts; i++) {
      await collection().collect(rideId);
    }
    const issued = (await fetchReceipt(rideId, w.customer)).json().data;
    assert.equal(issued.snapshotJson.payment.status, 'UNPAID');

    // The rider settles later. The receipt is a record of what happened, not a
    // live view of the obligation -- settlement is its own event.
    restoreGateway?.();
    restoreGateway = null;
    await fundWallet(app, w.customer, 3000);
    assert.equal(await collection().settleReceivable(rideId), 'COLLECTED');

    const after = (await fetchReceipt(rideId, w.customer)).json().data;
    assert.deepEqual(after, issued, 'the receipt is unchanged');
  });

  it('lets the driver on the ride read it, and refuses an unrelated rider', async () => {
    const w = await world();
    await fundWallet(app, w.customer, 3000);
    const { rideId } = await completeRide(app, w, {
      distanceKm: 5,
      durationMin: 12,
      paymentMethod: 'WALLET',
    });
    await drainOutbox();

    assert.equal((await fetchReceipt(rideId, w.driver)).statusCode, 200, 'the driver drove it');

    const stranger = await rideWorld(app, {
      customer: '+919876607003',
      driver: '+919876607004',
    });
    const refused = await fetchReceipt(rideId, stranger.customer);
    assert.equal(refused.statusCode, 403, refused.payload);
  });
});

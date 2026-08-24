import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, bootEventConsumers, db, drainOutbox, resetState } from './helpers/harness.js';
import { completeRide, fundWallet, rideWorld, type RideWorld } from './helpers/ride-flow.js';
import { container } from '../../src/core/di.js';
import { Decimal } from '../../src/modules/payments/types/index.js';
import type { Unsubscribe } from '../../src/core/events/index.js';
import type { RideCollectionService } from '../../src/modules/payments/services/collection/collection.service.js';
import type { PaymentGatewayProvider } from '../../src/modules/payments/services/gateway/gateway.provider.js';
import { paymentConfig } from '../../src/config/payment/payment.config.js';

const CUSTOMER = '+919876608001';
const DRIVER = '+919876608002';

describe('rider debt threshold (integration, real HTTP)', () => {
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

  /// Leaves the rider owing exactly `amount` by driving a ride to a receivable
  /// and then rewriting its fare to the figure the test needs. The boundary is
  /// what matters here, and a real fare cannot be dialled to the paise.
  async function oweExactly(w: RideWorld, amount: number): Promise<string> {
    declineGateway();
    const { rideId } = await completeRide(app, w, { distanceKm: 8, durationMin: 18 });
    await drainOutbox();
    for (let i = 1; i < paymentConfig.collectionMaxAttempts; i++) {
      await collection().collect(rideId);
    }
    const ride = await db().client.ride.findUniqueOrThrow({ where: { id: rideId } });
    assert.equal(ride.paymentStatus, 'FAILED', 'precondition: the receivable is open');
    await db().client.rideFare.update({ where: { rideId }, data: { totalFare: amount } });
    restoreGateway?.();
    restoreGateway = null;
    return rideId;
  }

  function requestRide(w: RideWorld) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/rides/requests',
      headers: w.customer.authHeader,
      payload: {
        vehicleTypeId: w.vehicleTypeId,
        pickupLat: 12.9716,
        pickupLng: 77.5946,
        dropLat: 12.9806,
        dropLng: 77.5946,
        paymentMethod: 'CARD',
      },
    });
  }

  it('refuses a new ride at exactly the limit, and allows one a paise below', async () => {
    const limit = paymentConfig.riderDebtLimit;

    const below = await world();
    await oweExactly(below, limit - 0.01);
    const allowed = await requestRide(below);
    assert.equal(
      allowed.statusCode,
      200,
      `one paise below the limit must be allowed: ${allowed.payload}`,
    );
    await resetState();

    const at = await world();
    await oweExactly(at, limit);
    const refused = await requestRide(at);
    // BD-2 says *reaches or exceeds*, so the comparison is `>=` and the
    // boundary itself is refused.
    assert.equal(refused.statusCode, 409, refused.payload);
    assert.equal(refused.json().error.code, 'RIDER_DEBT_LIMIT_EXCEEDED');
  });

  it('never blocks the rider from settling what they owe', async () => {
    const w = await world();
    const rideId = await oweExactly(w, paymentConfig.riderDebtLimit + 100);
    assert.equal((await requestRide(w)).statusCode, 409, 'precondition: new rides are blocked');

    await fundWallet(app, w.customer, 5000);
    const settled = await app.inject({
      method: 'POST',
      url: `/api/v1/rides/${rideId}/payment/retry`,
      headers: { ...w.customer.authHeader, 'idempotency-key': randomUUID() },
      payload: {},
    });

    // Refusing someone permission to pay you is self-defeating, so the
    // threshold deliberately does not guard this route.
    assert.equal(settled.statusCode, 200, settled.payload);
    assert.equal(settled.json().data.collectionState, 'PAID');
    assert.equal((await requestRide(w)).statusCode, 200, 'and the block lifts once they have paid');
  });

  // Race 8 -- concurrent ride requests from a rider at the boundary

  it('does not let concurrent requests slip past the threshold', async () => {
    const w = await world();
    await oweExactly(w, paymentConfig.riderDebtLimit);

    const results = await Promise.all([requestRide(w), requestRide(w), requestRide(w)]);

    assert.deepEqual(
      results.map((r) => r.statusCode),
      [409, 409, 409],
      'every one is refused -- the debt is read fresh on each request',
    );
  });

  it('allows exactly one ride when several requests race from a clean rider', async () => {
    const w = await world();

    const results = await Promise.all([requestRide(w), requestRide(w), requestRide(w)]);
    const accepted = results.filter((r) => r.statusCode === 200);

    // The correctness boundary is the existing `rides_active_customer_key`
    // partial unique index, not the debt check and not a new lock.
    assert.equal(accepted.length, 1, results.map((r) => r.statusCode).join(','));
  });

  it('stops counting a debt once it is written off', async () => {
    const w = await world();
    const rideId = await oweExactly(w, paymentConfig.riderDebtLimit + 50);
    assert.equal((await requestRide(w)).statusCode, 409, 'precondition: blocked');

    await db().client.ridePayment.create({
      data: {
        rideId,
        amount: new Decimal(paymentConfig.riderDebtLimit + 50),
        method: 'WRITE_OFF',
        status: 'WRITTEN_OFF',
      },
    });

    // BD-1c: written off means no longer outstanding.
    assert.equal((await requestRide(w)).statusCode, 200);
  });
});

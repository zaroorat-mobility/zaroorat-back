import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import {
  bootApp,
  bootEventConsumers,
  db,
  drainOutbox,
  loginAs,
  resetState,
  type LoggedInUser,
} from './helpers/harness.js';
import { grantRole } from './helpers/fixtures.js';
import {
  accountBalance,
  completeRide as flowCompleteRide,
  fundWallet,
  rideWorld,
  type FareRow,
  type RideWorld,
} from './helpers/ride-flow.js';
import type { Unsubscribe } from '../../src/core/events/index.js';
import { container } from '../../src/core/di.js';
import { Decimal } from '../../src/modules/payments/types/index.js';
import type { SettlementService } from '../../src/modules/payments/services/settlement/settlement.service.js';
import type { RideCollectionService } from '../../src/modules/payments/services/collection/collection.service.js';
import type { PaymentGatewayProvider } from '../../src/modules/payments/services/gateway/gateway.provider.js';
import { paymentConfig } from '../../src/config/payment/payment.config.js';

const CUSTOMER = '+919876603001';
const DRIVER = '+919876603002';
const FINANCE = '+919876603003';

describe('driver earnings pipeline (integration, real HTTP)', () => {
  let app: FastifyInstance;
  let stopConsumers: Unsubscribe;

  before(async () => {
    app = await bootApp();
    // The collection consumer is what charges a completed ride, so without it
    // subscribed nothing in this suite would ever reach the ledger.
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
    await resetState();
  });

  const world = () => rideWorld(app, { customer: CUSTOMER, driver: DRIVER });

  async function loginWithRole(phone: string, role: string): Promise<LoggedInUser> {
    const user = await loginAs(app, phone);
    await grantRole(user.userId, role);
    return loginAs(app, phone);
  }

  async function completeRide(
    w: RideWorld,
    options: { distanceKm: number; durationMin: number; paymentMethod?: string },
  ): Promise<{ rideId: string; fare: FareRow }> {
    const ride = await flowCompleteRide(app, w, options);
    // Collection is a consumer now, not part of completion: the ledger must
    // not assert a payment that has not happened (FR-038). So the money-path
    // assertions below run after the relay has delivered `ride.completed` and
    // `RideCollectionService` has actually charged the ride.
    await drainOutbox();
    return ride;
  }

  const settlements = () => container.resolve<SettlementService>('settlementService');
  const collection = () => container.resolve<RideCollectionService>('rideCollectionService');

  let restoreGateway: (() => void) | null = null;

  /// Makes the gateway decline, so a ride can reach the receivable state.
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

  function surroundingPeriod(): { periodStart: Date; periodEnd: Date } {
    return {
      periodStart: new Date(Date.now() - 24 * 60 * 60 * 1000),
      periodEnd: new Date(Date.now() + 24 * 60 * 60 * 1000),
    };
  }

  describe('ride completion posts the double-entry group', () => {
    it('credits the driver and the platform, debiting the customer', async () => {
      const w = await world();
      const { rideId, fare } = await completeRide(w, { distanceKm: 12, durationMin: 25 });

      const entries = await db().client.paymentLedgerEntry.findMany({
        where: { referenceType: 'RIDE', referenceId: rideId },
      });
      assert.equal(entries.length, 3, 'customer debit + driver credit + commission credit');

      const debits = entries
        .filter((e) => e.direction === 'DEBIT')
        .reduce((s, e) => s.add(e.amount), new Decimal(0));
      const credits = entries
        .filter((e) => e.direction === 'CREDIT')
        .reduce((s, e) => s.add(e.amount), new Decimal(0));
      assert.equal(debits.toFixed(2), credits.toFixed(2));
      assert.equal(debits.toFixed(2), new Decimal(fare.totalFare).toFixed(2));

      assert.equal(
        (await accountBalance('DRIVER_PAYABLE', { accountRefId: w.driverId })).toFixed(2),
        new Decimal(fare.driverEarning).toFixed(2),
        'the platform now owes the driver exactly their earning',
      );
      assert.equal(
        (await accountBalance('PLATFORM_COMMISSION', { rideId })).toFixed(2),
        new Decimal(fare.platformCommission).toFixed(2),
      );
    });

    it('bills a longer ride more, and the books follow the fare', async () => {
      const w = await world();
      const short = await completeRide(w, { distanceKm: 2, durationMin: 8 });
      const long = await completeRide(w, { distanceKm: 40, durationMin: 75 });

      assert.ok(
        new Decimal(long.fare.totalFare).gt(new Decimal(short.fare.totalFare)),
        'a 40 km ride must cost more than a 2 km ride',
      );

      const expected = new Decimal(short.fare.driverEarning).add(
        new Decimal(long.fare.driverEarning),
      );
      assert.equal(
        (await accountBalance('DRIVER_PAYABLE', { accountRefId: w.driverId })).toFixed(2),
        expected.toFixed(2),
      );
    });

    it('does NOT credit the driver for a cash ride — they took the money', async () => {
      const w = await world();
      const { rideId, fare } = await completeRide(w, {
        distanceKm: 10,
        durationMin: 20,
        paymentMethod: 'CASH',
      });

      const entries = await db().client.paymentLedgerEntry.findMany({
        where: { referenceType: 'RIDE', referenceId: rideId },
      });
      assert.equal(entries.length, 2, 'driver debit + commission credit');

      const payable = await accountBalance('DRIVER_PAYABLE', { accountRefId: w.driverId });
      assert.equal(
        payable.toFixed(2),
        new Decimal(fare.platformCommission).neg().toFixed(2),
        'the driver owes the commission on a cash ride',
      );
      assert.ok(payable.lt(0));
    });

    it('posts exactly one entry group per ride, never a partial one', async () => {
      const w = await world();
      const { rideId } = await completeRide(w, { distanceKm: 5, durationMin: 10 });

      const fares = await db().client.rideFare.count({ where: { rideId } });
      const groups = await db().client.paymentLedgerEntry.findMany({
        where: { referenceType: 'RIDE', referenceId: rideId },
        select: { entryGroup: true },
      });
      assert.equal(fares, 1);
      assert.equal(new Set(groups.map((g) => g.entryGroup)).size, 1, 'exactly one entry group');
    });
  });

  describe('settlement is derived from completed rides', () => {
    it('sums the real fares instead of a hardcoded figure', async () => {
      const w = await world();
      const a = await completeRide(w, { distanceKm: 6, durationMin: 15 });
      const b = await completeRide(w, { distanceKm: 18, durationMin: 40 });

      const { periodStart, periodEnd } = surroundingPeriod();
      const settlement = await settlements().calculateSettlement({
        driverId: w.driverId,
        periodStart,
        periodEnd,
      });

      const expectedGross = new Decimal(a.fare.totalFare).add(new Decimal(b.fare.totalFare));
      const expectedCommission = new Decimal(a.fare.platformCommission).add(
        new Decimal(b.fare.platformCommission),
      );
      const expectedNet = new Decimal(a.fare.driverEarning).add(new Decimal(b.fare.driverEarning));

      assert.equal(new Decimal(settlement.grossEarnings).toFixed(2), expectedGross.toFixed(2));
      assert.equal(new Decimal(settlement.commission).toFixed(2), expectedCommission.toFixed(2));
      assert.equal(
        new Decimal(settlement.netPayable).toFixed(2),
        expectedNet.toFixed(2),
        'net payable is the sum of what the driver actually earned',
      );
      assert.notEqual(new Decimal(settlement.grossEarnings).toFixed(2), '1000.00');
    });

    it('settles a driver with no rides at zero, not at a placeholder', async () => {
      const w = await world();
      const { periodStart, periodEnd } = surroundingPeriod();

      const settlement = await settlements().calculateSettlement({
        driverId: w.driverId,
        periodStart,
        periodEnd,
      });

      assert.equal(new Decimal(settlement.netPayable).toFixed(2), '0.00');
    });

    it('nets a cash ride to the commission the driver owes', async () => {
      const w = await world();
      const cash = await completeRide(w, {
        distanceKm: 10,
        durationMin: 20,
        paymentMethod: 'CASH',
      });

      const { periodStart, periodEnd } = surroundingPeriod();
      const settlement = await settlements().calculateSettlement({
        driverId: w.driverId,
        periodStart,
        periodEnd,
      });

      assert.equal(new Decimal(settlement.grossEarnings).toFixed(2), '0.00', 'nothing collected');
      assert.equal(
        new Decimal(settlement.netPayable).toFixed(2),
        new Decimal(cash.fare.platformCommission).neg().toFixed(2),
      );
    });

    it('excludes rides outside the period', async () => {
      const w = await world();
      await completeRide(w, { distanceKm: 10, durationMin: 20 });

      const settlement = await settlements().calculateSettlement({
        driverId: w.driverId,
        periodStart: new Date(Date.now() - 72 * 60 * 60 * 1000),
        periodEnd: new Date(Date.now() - 48 * 60 * 60 * 1000),
      });

      assert.equal(new Decimal(settlement.netPayable).toFixed(2), '0.00');
    });

    it('is idempotent — a second run returns the same row, not a second period', async () => {
      const w = await world();
      await completeRide(w, { distanceKm: 10, durationMin: 20 });
      const { periodStart, periodEnd } = surroundingPeriod();

      const first = await settlements().calculateSettlement({
        driverId: w.driverId,
        periodStart,
        periodEnd,
      });
      const second = await settlements().calculateSettlement({
        driverId: w.driverId,
        periodStart,
        periodEnd,
      });

      assert.equal(first.id, second.id);
      assert.equal(
        await db().client.driverSettlement.count({ where: { driverId: w.driverId } }),
        1,
      );
    });

    it('agrees with the ledger to the paise', async () => {
      const w = await world();
      await completeRide(w, { distanceKm: 7.7, durationMin: 19 });
      await completeRide(w, { distanceKm: 3.3, durationMin: 9 });

      const { periodStart, periodEnd } = surroundingPeriod();
      const settlement = await settlements().calculateSettlement({
        driverId: w.driverId,
        periodStart,
        periodEnd,
      });

      assert.equal(
        new Decimal(settlement.netPayable).toFixed(2),
        (await accountBalance('DRIVER_PAYABLE', { accountRefId: w.driverId })).toFixed(2),
        'settlement net payable must equal the DRIVER_PAYABLE balance',
      );
    });
  });

  describe('payout is bounded by the derived settlement', () => {
    async function settleAndPay(
      w: RideWorld,
      finance: LoggedInUser,
      amount: number,
      idempotencyKey = randomUUID(),
    ): Promise<{ status: number; body: string; settlementId: string; netPayable: Decimal }> {
      const { periodStart, periodEnd } = surroundingPeriod();
      const settlement = await settlements().calculateSettlement({
        driverId: w.driverId,
        periodStart,
        periodEnd,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/payments/payouts',
        headers: { ...finance.authHeader, 'idempotency-key': idempotencyKey },
        payload: { driverId: w.driverId, settlementId: settlement.id, amount },
      });

      return {
        status: response.statusCode,
        body: response.payload,
        settlementId: settlement.id,
        netPayable: new Decimal(settlement.netPayable),
      };
    }

    it('pays out exactly what the rides earned', async () => {
      const w = await world();
      const ride = await completeRide(w, { distanceKm: 12, durationMin: 25 });
      const earned = Number(new Decimal(ride.fare.driverEarning).toFixed(2));

      const finance = await loginWithRole(FINANCE, 'finance');
      const result = await settleAndPay(w, finance, earned);

      assert.equal(result.status, 200, result.body);
      assert.equal(result.netPayable.toFixed(2), earned.toFixed(2));

      const paid = await db().client.driverPayout.aggregate({
        where: { driverId: w.driverId, status: { not: 'FAILED' } },
        _sum: { amount: true },
      });
      assert.equal((paid._sum.amount ?? new Decimal(0)).toFixed(2), earned.toFixed(2));
    });

    it('refuses a payout one paise over the earned amount', async () => {
      const w = await world();
      const ride = await completeRide(w, { distanceKm: 12, durationMin: 25 });
      const overspend = Number(new Decimal(ride.fare.driverEarning).add(0.01).toFixed(2));

      const finance = await loginWithRole(FINANCE, 'finance');
      const result = await settleAndPay(w, finance, overspend);

      assert.equal(result.status, 422, result.body);
      assert.equal(JSON.parse(result.body).error.code, 'PAYOUT_EXCEEDS_AVAILABLE');
      assert.equal(await db().client.driverPayout.count({ where: { driverId: w.driverId } }), 0);
    });

    it('refuses any payout to a driver whose cash rides left them owing', async () => {
      const w = await world();
      await completeRide(w, { distanceKm: 10, durationMin: 20, paymentMethod: 'CASH' });

      const finance = await loginWithRole(FINANCE, 'finance');
      const result = await settleAndPay(w, finance, 1);

      assert.ok(result.netPayable.lt(0), 'the driver owes commission');
      assert.equal(result.status, 422, result.body);
    });

    it('cannot double-spend the earned balance under concurrency', async () => {
      const w = await world();
      const ride = await completeRide(w, { distanceKm: 20, durationMin: 45 });
      const earned = Number(new Decimal(ride.fare.driverEarning).toFixed(2));

      const { periodStart, periodEnd } = surroundingPeriod();
      const settlement = await settlements().calculateSettlement({
        driverId: w.driverId,
        periodStart,
        periodEnd,
      });
      const finance = await loginWithRole(FINANCE, 'finance');

      const pay = () =>
        app.inject({
          method: 'POST',
          url: '/api/v1/admin/payments/payouts',
          headers: { ...finance.authHeader, 'idempotency-key': randomUUID() },
          payload: { driverId: w.driverId, settlementId: settlement.id, amount: earned },
        });

      await Promise.all([pay(), pay(), pay()]);

      const paid = await db().client.driverPayout.aggregate({
        where: { driverId: w.driverId, status: { not: 'FAILED' } },
        _sum: { amount: true },
      });
      assert.equal(
        (paid._sum.amount ?? new Decimal(0)).toFixed(2),
        earned.toFixed(2),
        'the earned balance is spent once, however the requests interleave',
      );
    });

    it('replays a repeated idempotency key without paying twice', async () => {
      const w = await world();
      const ride = await completeRide(w, { distanceKm: 15, durationMin: 30 });
      const half = Number(new Decimal(ride.fare.driverEarning).div(2).toFixed(2));
      const key = randomUUID();

      const finance = await loginWithRole(FINANCE, 'finance');
      const first = await settleAndPay(w, finance, half, key);
      const second = await settleAndPay(w, finance, half, key);

      assert.equal(first.status, 200, first.body);
      assert.equal(second.status, 200, second.body);
      assert.equal(await db().client.driverPayout.count({ where: { driverId: w.driverId } }), 1);
    });
  });

  describe('an uncollected ride still earns the driver their fare (BD-1)', () => {
    it('includes the earning in full and parks the shortfall as a receivable', async () => {
      const w = await world();
      declineGateway();
      const { rideId, fare } = await completeRide(w, { distanceKm: 11, durationMin: 24 });
      for (let i = 1; i < paymentConfig.collectionMaxAttempts; i++) {
        await collection().collect(rideId);
      }
      const ride = await db().client.ride.findUniqueOrThrow({ where: { id: rideId } });
      assert.equal(ride.paymentStatus, 'FAILED', 'precondition: nobody paid for this ride');

      const { periodStart, periodEnd } = surroundingPeriod();
      const settlement = await settlements().calculateSettlement({
        driverId: w.driverId,
        periodStart,
        periodEnd,
      });

      // The driver drove the trip. Whether the rider paid is the platform's
      // problem, not theirs -- a settlement query that filtered on collection
      // success would be a defect, not an optimisation.
      assert.equal(
        new Decimal(settlement.netPayable).toFixed(2),
        new Decimal(fare.driverEarning).toFixed(2),
        'paid in full despite the collection failing',
      );
      assert.equal(
        (await accountBalance('CUSTOMER_RECEIVABLE', { rideId })).toFixed(2),
        new Decimal(fare.totalFare).neg().toFixed(2),
        'the shortfall sits on the customer, not the driver',
      );
    });

    it('does not pay the driver again when the rider settles later', async () => {
      const w = await world();
      declineGateway();
      const { rideId, fare } = await completeRide(w, {
        distanceKm: 9,
        durationMin: 20,
        paymentMethod: 'WALLET',
      });
      for (let i = 1; i < paymentConfig.collectionMaxAttempts; i++) {
        await collection().collect(rideId);
      }
      // Two windows that do not overlap, so the ride belongs to the first one
      // only -- otherwise the later settlement would legitimately count the
      // same ride again and prove nothing.
      const boundary = new Date();
      const day = 24 * 60 * 60 * 1000;
      const first = await settlements().calculateSettlement({
        driverId: w.driverId,
        periodStart: new Date(boundary.getTime() - day),
        periodEnd: boundary,
      });

      restoreGateway?.();
      restoreGateway = null;
      await fundWallet(app, w.customer, 5000);
      assert.equal(await collection().settleReceivable(rideId), 'COLLECTED');

      // A later period. Earnings were recognised when the receivable was
      // created (transition 6); settling it is transition 7b, which moves the
      // balancing side only.
      const later = await settlements().calculateSettlement({
        driverId: w.driverId,
        periodStart: boundary,
        periodEnd: new Date(boundary.getTime() + day),
      });
      assert.equal(
        new Decimal(later.netPayable).toFixed(2),
        '0.00',
        'the settlement does not grow because the rider finally paid',
      );
      assert.equal(
        (await accountBalance('DRIVER_PAYABLE', { rideId })).toFixed(2),
        new Decimal(fare.driverEarning).toFixed(2),
        'and the driver is credited exactly once across both periods',
      );
      assert.ok(new Decimal(first.netPayable).gt(0));
    });
  });

  /// C-2. `RideRequest.surgeMultiplier` is written at booking precisely so the
  /// price the customer agreed to survives the trip. `completeRide` never read
  /// it back, so `PricingService.price` fell through to its `?? 1` default and
  /// a ride quoted at 1.8x was invoiced at 1.0x — the premium vanished from the
  /// bill, the driver's earning and the platform's commission at once, and
  /// `RideFare` recorded a surge of 1 with an amount of 0, so nothing in the
  /// books showed it had ever applied.
  describe('the surge the customer agreed to (C-2)', () => {
    async function surgePickup(multiplier: string, vehicleTypeId?: string): Promise<void> {
      const zoneId = randomUUID();
      await db().client.$executeRawUnsafe(
        `INSERT INTO surge_zones (id, city_code, name, boundary, is_active, created_at)
         VALUES ($1::uuid, 'GLOBAL', 'test-surge',
                 ST_GeogFromText('SRID=4326;POLYGON((77.50 12.90, 77.70 12.90, 77.70 13.05, 77.50 13.05, 77.50 12.90))'),
                 true, now())`,
        zoneId,
      );
      await db().client.surgeWindow.create({
        data: {
          zoneId,
          multiplier: new Decimal(multiplier),
          startsAt: new Date(Date.now() - 60_000),
          endsAt: new Date(Date.now() + 3_600_000),
          isActive: true,
          ...(vehicleTypeId !== undefined ? { vehicleTypeId } : {}),
        },
      });
    }

    it('invoices a surged ride at the multiplier quoted at booking', async () => {
      const world = await rideWorld(app, { customer: CUSTOMER, driver: DRIVER });
      await surgePickup('1.80');

      const { rideId } = await flowCompleteRide(app, world, {
        distanceKm: 8,
        durationMin: 18,
        paymentMethod: 'CASH',
      });

      const request = await db().client.rideRequest.findFirstOrThrow({
        where: { rides: { some: { id: rideId } } },
      });
      assert.equal(request.surgeMultiplier.toString(), '1.8', 'the quote carried the surge');

      const fare = await db().client.rideFare.findUniqueOrThrow({ where: { rideId } });
      assert.equal(
        fare.surgeMultiplier.toString(),
        '1.8',
        'and the invoice charges the same multiplier, not the 1.0 default',
      );
      assert.ok(
        fare.surgeAmount.gt(0),
        `a surged ride must carry a surge amount, got ${fare.surgeAmount.toString()}`,
      );
    });

    /// The premium is not cosmetic: it has to reach the two parties who split
    /// the fare, or the platform has quietly absorbed it.
    it('carries the premium into the driver earning and the commission', async () => {
      const plain = await rideWorld(app, { customer: CUSTOMER, driver: DRIVER });
      const flat = await flowCompleteRide(app, plain, {
        distanceKm: 8,
        durationMin: 18,
        paymentMethod: 'CASH',
      });
      const flatFare = await db().client.rideFare.findUniqueOrThrow({
        where: { rideId: flat.rideId },
      });

      await resetState();
      const surged = await rideWorld(app, { customer: CUSTOMER, driver: DRIVER });
      await surgePickup('1.80');
      const peak = await flowCompleteRide(app, surged, {
        distanceKm: 8,
        durationMin: 18,
        paymentMethod: 'CASH',
      });
      const peakFare = await db().client.rideFare.findUniqueOrThrow({
        where: { rideId: peak.rideId },
      });

      assert.ok(
        peakFare.totalFare.gt(flatFare.totalFare),
        `surged ${peakFare.totalFare} must exceed flat ${flatFare.totalFare}`,
      );
      assert.ok(
        peakFare.driverEarning.gt(flatFare.driverEarning),
        'the driver shares in the premium',
      );
      assert.ok(
        peakFare.platformCommission.gt(flatFare.platformCommission),
        'and so does the platform',
      );
    });

    it('leaves a ride booked outside any surge window at 1.0', async () => {
      const world = await rideWorld(app, { customer: CUSTOMER, driver: DRIVER });
      const { rideId } = await flowCompleteRide(app, world, {
        distanceKm: 8,
        durationMin: 18,
        paymentMethod: 'CASH',
      });
      const fare = await db().client.rideFare.findUniqueOrThrow({ where: { rideId } });
      assert.equal(fare.surgeMultiplier.toString(), '1', 'no surge zone means no surge');
      assert.equal(fare.surgeAmount.toString(), '0');
    });
  });
});

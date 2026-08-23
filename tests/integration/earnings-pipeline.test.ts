import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState, type LoggedInUser } from './helpers/harness.js';
import { grantRole, makeDriver, makeVehicle, makeVehicleType } from './helpers/fixtures.js';
import { container } from '../../src/core/di.js';
import { Decimal } from '../../src/modules/payments/types/index.js';
import type { SettlementService } from '../../src/modules/payments/services/settlement/settlement.service.js';

const CUSTOMER = '+919876603001';
const DRIVER = '+919876603002';
const FINANCE = '+919876603003';

describe('driver earnings pipeline (integration, real HTTP)', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await bootApp();

    await resetState();
  });
  after(async () => {
    await app.close();
  });

  afterEach(async () => {
    await resetState();
  });

  async function loginWithRole(phone: string, role: string): Promise<LoggedInUser> {
    const user = await loginAs(app, phone);
    await grantRole(user.userId, role);
    return loginAs(app, phone);
  }

  interface World {
    customer: LoggedInUser;
    driver: LoggedInUser;
    driverId: string;
    vehicleId: string;
    vehicleTypeId: string;
  }

  async function world(): Promise<World> {
    const customer = await loginAs(app, CUSTOMER);
    const driver = await loginWithRole(DRIVER, 'driver');
    const driverId = await makeDriver(driver.userId, { verified: true });
    const vehicleTypeId = await makeVehicleType();
    const vehicleId = await makeVehicle(vehicleTypeId);
    return { customer, driver, driverId, vehicleId, vehicleTypeId };
  }

  interface FareRow {
    totalFare: Decimal;
    driverEarning: Decimal;
    platformCommission: Decimal;
  }

  async function completeRide(
    w: World,
    options: { distanceKm: number; durationMin: number; paymentMethod?: string },
  ): Promise<{ rideId: string; fare: FareRow }> {
    const requested = await app.inject({
      method: 'POST',
      url: '/api/v1/rides/requests',
      headers: w.customer.authHeader,
      payload: {
        vehicleTypeId: w.vehicleTypeId,
        pickupLat: 12.9716,
        pickupLng: 77.5946,
        dropLat: 12.9352,
        dropLng: 77.6245,
        paymentMethod: options.paymentMethod ?? 'CARD',
      },
    });
    assert.equal(requested.statusCode, 200, requested.payload);
    const requestId = requested.json().data.id;

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/v1/rides/accept',
      headers: w.driver.authHeader,
      payload: { requestId, vehicleId: w.vehicleId },
    });
    assert.equal(accepted.statusCode, 200, accepted.payload);

    const rideId = accepted.json().data.ride.id;
    const otpCode = accepted.json().data.plaintextOtp;

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
      payload: { otpCode },
    });
    assert.equal(started.statusCode, 200, started.payload);

    const completed = await app.inject({
      method: 'POST',
      url: `/api/v1/rides/${rideId}/complete`,
      headers: w.driver.authHeader,
      payload: { actualDistanceKm: options.distanceKm, actualDurationMin: options.durationMin },
    });
    assert.equal(completed.statusCode, 200, completed.payload);

    const fare = await db().client.rideFare.findUniqueOrThrow({ where: { rideId } });
    return { rideId, fare: fare as unknown as FareRow };
  }

  async function accountBalance(
    account: string,
    scope: { accountRefId?: string; rideId?: string } = {},
  ): Promise<Decimal> {
    const entries = await db().client.paymentLedgerEntry.findMany({
      where: {
        account,
        ...(scope.accountRefId ? { accountRefId: scope.accountRefId } : {}),
        ...(scope.rideId ? { referenceType: 'RIDE', referenceId: scope.rideId } : {}),
      },
    });
    return entries.reduce(
      (sum, e) => (e.direction === 'CREDIT' ? sum.add(e.amount) : sum.sub(e.amount)),
      new Decimal(0),
    );
  }

  const settlements = () => container.resolve<SettlementService>('settlementService');

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

    it('writes fare and ledger in one transaction — never one without the other', async () => {
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
      w: World,
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
});

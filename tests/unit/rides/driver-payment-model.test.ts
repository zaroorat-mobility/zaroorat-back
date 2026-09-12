import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LifecycleService } from '../../../src/modules/rides/services/lifecycle/lifecycle.service.js';
import { PricingMetrics, PricingService } from '../../../src/modules/pricing';
import { VehicleEligibilityService } from '../../../src/modules/vehicles/services/vehicle-eligibility.service.js';
import { vehicleConfig } from '../../../src/config/vehicle/vehicle.config.js';
import { Decimal } from '../../../src/modules/rides/types/index.js';
import {
  PaymentModelNotSelectedError,
  DriverSubscriptionRequiredError,
  InsufficientCommissionBalanceError,
} from '../../../src/modules/rides/errors/ride.errors.js';

/// 004-driver-subscription-wallet. Exercises the exact flow spec.md requires:
/// COMMISSION determines its commission once, at acceptance, and only ever
/// deducts the stored amount at completion (never recalculating); SUBSCRIPTION
/// checks an active subscription and never touches the wallet at all.
function makeWorld() {
  const rides = new Map<string, Record<string, unknown>>();
  const requests = new Map<string, Record<string, unknown>>();
  const offers = new Map<string, Record<string, unknown>>();
  const ledgerGroups: Array<Record<string, unknown>[]> = [];
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const activeRideByDriver = new Map<string, string>();

  const rideRepo = {
    async lockForUpdate(id: string) {
      return rides.get(id) ? { ...rides.get(id) } : null;
    },
    async findActiveByDriver(driverId: string) {
      const rideId = activeRideByDriver.get(driverId);
      return rideId ? { ...rides.get(rideId) } : null;
    },
    async updateStatusIf(
      id: string,
      expected: string,
      next: string,
      extra: Record<string, unknown> = {},
    ) {
      const ride = rides.get(id);
      if (!ride || ride.status !== expected) return false;
      rides.set(id, { ...ride, ...extra, status: next });
      return true;
    },
    async create(input: Record<string, unknown>) {
      const id = `ride_${rides.size + 1}`;
      const ride = { id, status: 'ACCEPTED', ...input };
      rides.set(id, ride);
      activeRideByDriver.set(input.driverId as string, id);
      return ride;
    },
  };

  const requestRepo = {
    async lockForUpdate(id: string) {
      return requests.get(id) ? { ...requests.get(id) } : null;
    },
    async findById(id: string) {
      return requests.get(id) ? { ...requests.get(id) } : null;
    },
    async claimForMatch(id: string) {
      const request = requests.get(id);
      if (!request || !['CREATED', 'SEARCHING'].includes(request.status as string)) return false;
      requests.set(id, { ...request, status: 'MATCHED' });
      return true;
    },
  };

  const dispatchRepo = {
    async lockActionableOffer(requestId: string, driverId: string) {
      const offer = offers.get(`${requestId}:${driverId}`);
      return offer ? { ...offer } : null;
    },
    async resolveOffers() {},
  };

  const driverStatusRepository = {
    async getStatus() {
      return { status: 'ONLINE' };
    },
    async updateStatus() {},
  };

  // Configurable per test: maps driverId -> paymentModel ('COMMISSION' |
  // 'SUBSCRIPTION' | null/undefined for "not selected").
  const paymentModelByDriver = new Map<string, string | null>();
  const driverRepository = {
    async findById(driverId: string) {
      return {
        id: driverId,
        userId: `user_of_${driverId}`,
        paymentModel: paymentModelByDriver.has(driverId)
          ? paymentModelByDriver.get(driverId)
          : 'COMMISSION',
      };
    },
    async recordCompletedRide() {},
  };

  const vehicleOwnerByVehicleId = new Map([['v1', 'd1']]);
  const vehicleRepository = {
    async findById(vehicleId: string) {
      return {
        id: vehicleId,
        isActive: true,
        currentDriverId: vehicleOwnerByVehicleId.get(vehicleId) ?? null,
        vehicleTypeId: 'v1',
        verificationStatus: 'VERIFIED',
      };
    },
  };
  const vehicleAssignmentRepository = {
    async findActiveForDriver(driverId: string) {
      for (const [vehicleId, owner] of vehicleOwnerByVehicleId) {
        if (owner === driverId) return { driverId, vehicleId, status: 'ACTIVE' };
      }
      return null;
    },
  };
  const vehicleEligibilityService = new VehicleEligibilityService(
    vehicleRepository as never,
    vehicleAssignmentRepository as never,
    {
      async findByVehicleId() {
        return vehicleConfig.requiredDocumentTypes.map((documentType) => ({
          documentType,
          verificationStatus: 'VERIFIED',
          expiresAt: null,
        }));
      },
    } as never,
  );

  const pricingService = new PricingService(
    {
      async findActiveRule() {
        return null;
      },
      async findBestActiveRule() {
        return null;
      },
      async findById() {
        return null;
      },
    } as never,
    new PricingMetrics(),
  );

  // Configurable per test: balance a COMMISSION driver's wallet reports.
  const walletBalanceByDriver = new Map<string, Decimal>();
  const hasSufficientBalanceCalls: { driverId: string; commissionAmount: Decimal }[] = [];
  const deductInTxCalls: { driverId: string; rideId: string; commissionAmount: Decimal }[] = [];
  const deductedRideIds = new Set<string>();
  const commissionWalletService = {
    async hasSufficientBalance(driverId: string, commissionAmount: Decimal) {
      hasSufficientBalanceCalls.push({ driverId, commissionAmount });
      const balance = walletBalanceByDriver.get(driverId) ?? new Decimal(0);
      return balance.gte(commissionAmount);
    },
    async deductInTx(driverId: string, rideId: string, commissionAmount: Decimal) {
      deductInTxCalls.push({ driverId, rideId, commissionAmount });
      if (deductedRideIds.has(rideId)) {
        return { outcome: 'ALREADY_PROCESSED' as const };
      }
      const balance = walletBalanceByDriver.get(driverId) ?? new Decimal(0);
      if (balance.lt(commissionAmount)) {
        return {
          outcome: 'INSUFFICIENT_BALANCE' as const,
          commissionAmount,
          actualBalance: balance,
        };
      }
      deductedRideIds.add(rideId);
      walletBalanceByDriver.set(driverId, balance.sub(commissionAmount));
      return {
        outcome: 'DEDUCTED' as const,
        amount: commissionAmount,
        transaction: { id: `wtx_${rideId}` } as never,
      };
    },
  };

  const subscriptionByDriver = new Map<
    string,
    { expiryDate: Date | null; status: string } | null
  >();
  const driverSubscriptionRepository = {
    async findActive(driverId: string) {
      return subscriptionByDriver.get(driverId) ?? null;
    },
  };

  const ledgerService = {
    async recordTripPayment() {
      return [];
    },
    async postTransactionGroup(items: Record<string, unknown>[]) {
      ledgerGroups.push(items);
      return [];
    },
  };

  const service = new LifecycleService(
    rideRepo as never,
    requestRepo as never,
    { async record() {} } as never,
    dispatchRepo as never,
    { async verify() {} } as never,
    { async assertAllowed() {}, async recordFailure() {}, async clear() {} } as never,
    pricingService,
    {} as never,
    {
      async create(f: { rideId: string }) {
        return f;
      },
    } as never,
    { async processCancellation() {} } as never,
    ledgerService as never,
    driverStatusRepository as never,
    driverRepository as never,
    vehicleRepository as never,
    vehicleAssignmentRepository as never,
    vehicleEligibilityService,
    {
      async execute<T>(fn: (tx: unknown) => Promise<T>) {
        return fn({});
      },
    } as never,
    {
      async publish(e: { type?: string; data?: Record<string, unknown> }) {
        events.push({ type: e?.type ?? 'event', data: e?.data ?? {} });
      },
    } as never,
    { rideCompleted() {}, rideCancelled() {}, driverArriving() {} } as never,
    {
      tripDistance: {
        async add() {},
        async read() {
          return 0;
        },
        async reset() {},
      },
    } as never,
    commissionWalletService as never,
    driverSubscriptionRepository as never,
  );

  function offer(requestId: string, driverId: string, overrides: Record<string, unknown> = {}) {
    offers.set(`${requestId}:${driverId}`, {
      id: `dsp_${offers.size + 1}`,
      requestId,
      driverId,
      response: 'PENDING',
      expiresAt: new Date(Date.now() + 30_000),
      ...overrides,
    });
  }

  function searchingRequest(id: string, overrides: Record<string, unknown> = {}) {
    requests.set(id, {
      id,
      status: 'SEARCHING',
      customerId: 'cust_1',
      vehicleTypeId: 'v1',
      pickupLat: 1,
      pickupLng: 1,
      estimatedDistanceKm: 10,
      estimatedDurationMin: 20,
      ...overrides,
    });
  }

  function seedRide(id: string, status: string, overrides: Record<string, unknown> = {}) {
    rides.set(id, {
      id,
      status,
      requestId: 'req_1',
      driverId: 'd1',
      customerId: 'cust_1',
      vehicleTypeId: 'v1',
      paymentMethod: 'CARD',
      waitTimeMin: 0,
      ...overrides,
    });
  }

  return {
    service,
    offer,
    searchingRequest,
    seedRide,
    rides,
    requests,
    paymentModelByDriver,
    walletBalanceByDriver,
    subscriptionByDriver,
    hasSufficientBalanceCalls,
    deductInTxCalls,
    ledgerGroups,
    events,
  };
}

describe('Driver payment model — commission wallet & subscription (004-driver-subscription-wallet)', () => {
  describe('acceptance', () => {
    it('refuses to accept when the driver has not selected a payment model', async () => {
      const world = makeWorld();
      world.searchingRequest('req_1');
      world.offer('req_1', 'd1');
      world.paymentModelByDriver.set('d1', null);

      await assert.rejects(
        () =>
          world.service.acceptRideRequest({ requestId: 'req_1', driverId: 'd1', vehicleId: 'v1' }),
        PaymentModelNotSelectedError,
      );
      assert.equal(world.rides.size, 0);
    });

    it('determines commission once at acceptance, stores it on the ride, and never deducts at accept time', async () => {
      const world = makeWorld();
      world.searchingRequest('req_1');
      world.offer('req_1', 'd1');
      world.paymentModelByDriver.set('d1', 'COMMISSION');
      world.walletBalanceByDriver.set('d1', new Decimal(1000));

      const { ride } = await world.service.acceptRideRequest({
        requestId: 'req_1',
        driverId: 'd1',
        vehicleId: 'v1',
      });

      assert.equal(ride.driverPaymentModel, 'COMMISSION');
      assert.ok(ride.commissionAmount instanceof Decimal);
      assert.ok((ride.commissionAmount as InstanceType<typeof Decimal>).gt(0));
      // Read-only check only — no deduction call at all during acceptance.
      assert.equal(world.deductInTxCalls.length, 0, 'acceptance must never deduct');
      assert.equal(world.hasSufficientBalanceCalls.length, 1);
      // The wallet balance itself is untouched — no reservation/freeze/hold.
      assert.equal(world.walletBalanceByDriver.get('d1')?.toString(), '1000');
    });

    it('rejects acceptance when the commission wallet balance is insufficient, and does not create a ride', async () => {
      const world = makeWorld();
      world.searchingRequest('req_1');
      world.offer('req_1', 'd1');
      world.paymentModelByDriver.set('d1', 'COMMISSION');
      world.walletBalanceByDriver.set('d1', new Decimal(0));

      await assert.rejects(
        () =>
          world.service.acceptRideRequest({ requestId: 'req_1', driverId: 'd1', vehicleId: 'v1' }),
        InsufficientCommissionBalanceError,
      );
      assert.equal(world.rides.size, 0, 'no ride may be created on rejection');
      assert.equal(
        world.requests.get('req_1')?.status,
        'SEARCHING',
        'the request must stay claimable by another driver',
      );
    });

    it('requires an active subscription for a SUBSCRIPTION driver and never checks the wallet', async () => {
      const world = makeWorld();
      world.searchingRequest('req_1');
      world.offer('req_1', 'd1');
      world.paymentModelByDriver.set('d1', 'SUBSCRIPTION');
      world.subscriptionByDriver.set('d1', null);

      await assert.rejects(
        () =>
          world.service.acceptRideRequest({ requestId: 'req_1', driverId: 'd1', vehicleId: 'v1' }),
        DriverSubscriptionRequiredError,
      );
      assert.equal(
        world.hasSufficientBalanceCalls.length,
        0,
        'a subscription driver never touches the wallet',
      );
    });

    it('refuses an expired subscription even if a row still exists', async () => {
      const world = makeWorld();
      world.searchingRequest('req_1');
      world.offer('req_1', 'd1');
      world.paymentModelByDriver.set('d1', 'SUBSCRIPTION');
      world.subscriptionByDriver.set('d1', {
        status: 'ACTIVE',
        expiryDate: new Date(Date.now() - 1000),
      });

      await assert.rejects(
        () =>
          world.service.acceptRideRequest({ requestId: 'req_1', driverId: 'd1', vehicleId: 'v1' }),
        DriverSubscriptionRequiredError,
      );
    });

    it('accepts a SUBSCRIPTION driver with an active subscription, storing a null commissionAmount', async () => {
      const world = makeWorld();
      world.searchingRequest('req_1');
      world.offer('req_1', 'd1');
      world.paymentModelByDriver.set('d1', 'SUBSCRIPTION');
      world.subscriptionByDriver.set('d1', {
        status: 'ACTIVE',
        expiryDate: new Date(Date.now() + 86_400_000),
      });

      const { ride } = await world.service.acceptRideRequest({
        requestId: 'req_1',
        driverId: 'd1',
        vehicleId: 'v1',
      });

      assert.equal(ride.driverPaymentModel, 'SUBSCRIPTION');
      assert.equal(ride.commissionAmount, null);
      assert.equal(world.hasSufficientBalanceCalls.length, 0);
    });
  });

  describe('completion', () => {
    it('deducts exactly the stored commissionAmount — never recalculating from the final fare', async () => {
      const world = makeWorld();
      const storedCommission = new Decimal(37.5);
      world.seedRide('ride_1', 'IN_PROGRESS', {
        driverPaymentModel: 'COMMISSION',
        commissionAmount: storedCommission,
      });
      world.walletBalanceByDriver.set('d1', new Decimal(100));

      await world.service.completeRide('ride_1', 'd1', 12, 25);

      assert.equal(world.deductInTxCalls.length, 1);
      assert.equal(
        world.deductInTxCalls[0]?.commissionAmount.toString(),
        storedCommission.toString(),
        'the deducted amount must be the value stored at acceptance, not a recomputed one',
      );
      assert.equal(world.walletBalanceByDriver.get('d1')?.toString(), '62.5');
      assert.equal(world.ledgerGroups.length, 1, 'exactly one commission ledger group is posted');
      assert.ok(world.events.some((e) => e.type === 'driver.commission_wallet.debited'));
    });

    it('never touches the wallet for a SUBSCRIPTION-model ride', async () => {
      const world = makeWorld();
      world.seedRide('ride_1', 'IN_PROGRESS', {
        driverPaymentModel: 'SUBSCRIPTION',
        commissionAmount: null,
      });

      await world.service.completeRide('ride_1', 'd1', 12, 25);

      assert.equal(world.deductInTxCalls.length, 0);
      assert.equal(world.ledgerGroups.length, 0);
    });

    it('leaves a legacy ride with no payment model untouched', async () => {
      const world = makeWorld();
      world.seedRide('ride_1', 'IN_PROGRESS');

      await world.service.completeRide('ride_1', 'd1', 12, 25);

      assert.equal(world.deductInTxCalls.length, 0);
    });

    it('completes the ride even when the wallet balance is insufficient at completion — never a partial deduction', async () => {
      const world = makeWorld();
      const storedCommission = new Decimal(50);
      world.seedRide('ride_1', 'IN_PROGRESS', {
        driverPaymentModel: 'COMMISSION',
        commissionAmount: storedCommission,
      });
      world.walletBalanceByDriver.set('d1', new Decimal(10));

      const completed = await world.service.completeRide('ride_1', 'd1', 12, 25);

      assert.equal(completed.status, 'COMPLETED', 'the ride still completes');
      // Balance is untouched — no partial/capped deduction was written.
      assert.equal(world.walletBalanceByDriver.get('d1')?.toString(), '10');
      assert.equal(
        world.ledgerGroups.length,
        0,
        'no ledger entry for a deduction that did not happen',
      );
      assert.ok(world.events.some((e) => e.type === 'driver.commission_wallet.collection_failed'));
    });

    it('is idempotent: completing the same commission ride twice deducts only once', async () => {
      const world = makeWorld();
      const storedCommission = new Decimal(20);
      world.seedRide('ride_1', 'IN_PROGRESS', {
        driverPaymentModel: 'COMMISSION',
        commissionAmount: storedCommission,
      });
      world.walletBalanceByDriver.set('d1', new Decimal(100));

      await world.service.completeRide('ride_1', 'd1', 12, 25);
      // Force the ride back to IN_PROGRESS to simulate a retried completion
      // call reaching the deduction branch a second time (e.g. a redelivered
      // event) without re-running the whole state machine from scratch.
      world.rides.set('ride_1', { ...world.rides.get('ride_1')!, status: 'IN_PROGRESS' });
      await world.service.completeRide('ride_1', 'd1', 12, 25);

      assert.equal(world.deductInTxCalls.length, 2, 'both attempts reach the deduction call');
      assert.equal(
        world.walletBalanceByDriver.get('d1')?.toString(),
        '80',
        'the balance reflects exactly one real deduction',
      );
      assert.equal(world.ledgerGroups.length, 1, 'only the first deduction posts a ledger group');
    });
  });
});

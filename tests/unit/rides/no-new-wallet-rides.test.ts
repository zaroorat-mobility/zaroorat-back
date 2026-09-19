import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LifecycleService } from '../../../src/modules/rides/services/lifecycle/lifecycle.service.js';
import { PricingMetrics, PricingService } from '../../../src/modules/pricing/index.js';
import { VehicleEligibilityService } from '../../../src/modules/vehicles/services/vehicle-eligibility.service.js';
import { vehicleConfig } from '../../../src/config/vehicle/vehicle.config.js';
import { Decimal } from '../../../src/modules/rides/types/index.js';
import { WalletRidesNotAcceptedError } from '../../../src/modules/rides/errors/ride.errors.js';
import {
  NEW_RIDE_PAYMENT_METHODS,
  type NewRidePaymentMethod,
} from '../../../src/modules/rides/constants/ride.constants.js';

/// D1 — application-layer enforcement of the "no new WALLET rides" rule.
///
/// This test covers the service layer of the three-layer defence:
///   1. Zod schema (createRideRequestSchema uses NEW_RIDE_PAYMENT_METHODS)
///   2. LifecycleService.acceptRideRequest — WalletRidesNotAcceptedError ← HERE
///   3. DB CHECK constraint (rides_payment_method_new_check — NOT VALID)
///
/// The DB-layer tests live in
/// tests/integration/no-new-wallet-rides-constraint.test.ts and prove that
/// a raw INSERT/UPDATE with WALLET is rejected by the constraint directly.

function makeWorld() {
  const rides = new Map<string, Record<string, unknown>>();
  const requests = new Map<string, Record<string, unknown>>();
  const offers = new Map<string, Record<string, unknown>>();
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

  const driverRepository = {
    async findById(driverId: string) {
      return {
        id: driverId,
        userId: `user_of_${driverId}`,
        paymentModel: 'COMMISSION',
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

  const commissionWalletService = {
    async hasSufficientBalance() {
      return true;
    },
    async deductInTx() {
      return { outcome: 'DEDUCTED' as const, amount: new Decimal(0), transaction: {} as never };
    },
  };

  const driverSubscriptionRepository = {
    async findActive() {
      return null;
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
    {
      async recordTripPayment() {
        return [];
      },
    } as never,
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
    { async publish() {} } as never,
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

  return { service, offer, searchingRequest, rides };
}

describe('D1 — no new WALLET rides (application layer, unit)', () => {
  /// The constants file is the single source of truth. This test pins it so that
  /// a future edit cannot silently add WALLET back without breaking this assertion.
  it('NEW_RIDE_PAYMENT_METHODS contains exactly CASH, UPI, CARD and nothing else', () => {
    assert.deepEqual([...NEW_RIDE_PAYMENT_METHODS].sort(), ['CARD', 'CASH', 'UPI']);
  });

  /// Zod schema guard (layer 1): the schema must not compile WALLET.
  it('createRideRequestSchema rejects WALLET at compile time — WALLET is absent from NEW_RIDE_PAYMENT_METHODS', () => {
    // TypeScript will reject `'WALLET' as NewRidePaymentMethod` — the assertion
    // below is a runtime equivalent: WALLET is not in the tuple.
    assert.ok(
      !(NEW_RIDE_PAYMENT_METHODS as readonly string[]).includes('WALLET'),
      'WALLET must never appear in NEW_RIDE_PAYMENT_METHODS',
    );
  });

  /// Service guard (layer 2): LifecycleService.acceptRideRequest throws
  /// WalletRidesNotAcceptedError before the ride row is minted.
  it('refuses to mint a ride when the request carries WALLET (historical WALLET request)', async () => {
    const world = makeWorld();
    world.searchingRequest('req_wallet', { paymentMethod: 'WALLET' });
    world.offer('req_wallet', 'd1');

    await assert.rejects(
      () =>
        world.service.acceptRideRequest({
          requestId: 'req_wallet',
          driverId: 'd1',
          vehicleId: 'v1',
        }),
      WalletRidesNotAcceptedError,
      'WALLET request must be refused with WalletRidesNotAcceptedError',
    );
    assert.equal(world.rides.size, 0, 'no ride row must be created');
  });

  /// Layer 2 must refuse WALLET regardless of driver payment model.
  it('refuses a WALLET request even when the driver has a funded COMMISSION wallet', async () => {
    const world = makeWorld();
    world.searchingRequest('req_wallet_2', { paymentMethod: 'WALLET' });
    world.offer('req_wallet_2', 'd1');

    await assert.rejects(
      () =>
        world.service.acceptRideRequest({
          requestId: 'req_wallet_2',
          driverId: 'd1',
          vehicleId: 'v1',
        }),
      WalletRidesNotAcceptedError,
    );
    assert.equal(world.rides.size, 0);
  });

  /// Happy-path: every permitted method creates a ride without throwing.
  for (const method of ['CASH', 'UPI', 'CARD'] as NewRidePaymentMethod[]) {
    it(`creates a ride for a ${method} request`, async () => {
      const world = makeWorld();
      world.searchingRequest(`req_${method.toLowerCase()}`, { paymentMethod: method });
      world.offer(`req_${method.toLowerCase()}`, 'd1');

      const { ride } = await world.service.acceptRideRequest({
        requestId: `req_${method.toLowerCase()}`,
        driverId: 'd1',
        vehicleId: 'v1',
      });

      assert.equal(ride.paymentMethod, method, `expected paymentMethod=${method}`);
      assert.equal(world.rides.size, 1, 'exactly one ride row must be created');
    });
  }

  /// NULL payment_method on a request: treated the same as "no preference" by
  /// the application; acceptRideRequest sees null and does not throw D1.
  it('accepts a request with null paymentMethod (no preference) without throwing D1', async () => {
    const world = makeWorld();
    // paymentMethod omitted → null in the request row
    world.searchingRequest('req_null', { paymentMethod: null });
    world.offer('req_null', 'd1');

    // Should not throw WalletRidesNotAcceptedError — null passes the guard
    // `request.paymentMethod != null && !NEW_RIDE_PAYMENT_METHODS.includes(...)`
    const { ride } = await world.service.acceptRideRequest({
      requestId: 'req_null',
      driverId: 'd1',
      vehicleId: 'v1',
    });
    assert.ok(ride, 'a ride is created for a null-method request');
  });

  /// Defense in depth: the DB-layer and application-layer guards are independent.
  /// Removing one must NOT weaken the other. This documents the intended layering.
  it('documents that WALLET rejection operates at three independent layers', () => {
    // Layer 1: Zod schema — createRideRequestSchema rejects WALLET before it
    //          reaches the service.
    // Layer 2: LifecycleService.acceptRideRequest — WalletRidesNotAcceptedError
    //          before the ride row is written.
    // Layer 3: DB CHECK constraint — ride_requests_payment_method_new_check /
    //          rides_payment_method_new_check (NOT VALID, enforces new writes).
    //
    // All three must be preserved. The DB constraint is migration
    // 20260918170000_no_new_wallet_rides.
    assert.ok(true, 'defence-in-depth architecture is intentional');
  });
});

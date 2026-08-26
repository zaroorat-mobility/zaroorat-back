import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LifecycleService } from '../../../src/modules/rides/services/lifecycle/lifecycle.service.js';
import { PricingService } from '../../../src/modules/pricing';
import { VehicleEligibilityService } from '../../../src/modules/vehicles/services/vehicle-eligibility.service.js';
import { vehicleConfig } from '../../../src/config/vehicle/vehicle.config.js';
import {
  InvalidRideStateTransitionError,
  RideDriverMismatchError,
  RideRequestAlreadyMatchedError,
  SelfRideNotAllowedError,
} from '../../../src/modules/rides/errors/ride.errors.js';

function makeWorld() {
  const rides = new Map<string, Record<string, unknown>>();
  const requests = new Map<string, Record<string, unknown>>();
  const fares: string[] = [];
  const statusEvents: string[] = [];
  const events: string[] = [];
  const ledgerPostings: string[] = [];
  const resolvedOffers: string[] = [];
  const driverStatuses: { driverId: string; status: string }[] = [];
  const driverStatusById = new Map<string, string>();
  const locks = new Map<string, Promise<void>>();
  // driverId -> rideId of the one active ride they're currently on, if any.
  const activeRideByDriver = new Map<string, string>();

  const rideRepo = {
    async lockForUpdate(id: string) {
      const previous = locks.get(id) ?? Promise.resolve();
      let release!: () => void;
      locks.set(
        id,
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      await previous;
      queueMicrotask(() => release());
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

  // Accepting now requires a live offer: the dispatch row is checked, not just
  // written. Keyed `requestId:driverId`, mirroring the real unique index.
  const offers = new Map<string, Record<string, unknown>>();

  const dispatchRepo = {
    async lockActionableOffer(requestId: string, driverId: string) {
      const offer = offers.get(`${requestId}:${driverId}`);
      return offer ? { ...offer } : null;
    },
    async resolveOffers(requestId: string, winningDriverId: string) {
      resolvedOffers.push(`${requestId}:${winningDriverId}`);
      for (const [key, offer] of offers) {
        if (offer.requestId !== requestId || offer.response !== 'PENDING') continue;
        offers.set(key, {
          ...offer,
          response: offer.driverId === winningDriverId ? 'ACCEPTED' : 'CANCELLED',
        });
      }
    },
  };

  const driverStatusRepository = {
    async getStatus(driverId: string) {
      return { driverId, status: driverStatusById.get(driverId) ?? 'ONLINE' };
    },
    async updateStatus(driverId: string, status: string) {
      driverStatuses.push({ driverId, status });
      driverStatusById.set(driverId, status);
    },
  };

  // Accepting now checks who owns the driver record, so that a driver cannot
  // accept a request they booked themselves. Every driver in this file maps to
  // a distinct user id; a test that wants the self-accept case seeds the
  // matching `customerId` on the request.
  const driverRepository = {
    async findById(driverId: string) {
      return { id: driverId, userId: `user_of_${driverId}` };
    },
  };

  const sentOtpSms: { to: string; body: string }[] = [];
  const userRepository = {
    async findById(userId: string) {
      return { id: userId, phoneNumber: `+91${userId}` };
    },
  };
  const notificationService = {
    async sendSms(to: string, body: string) {
      sentOtpSms.push({ to, body });
      return {};
    },
  };
  // Every test in this file pairs driver 'd1' with vehicle 'v1', 'd2' with
  // 'v2', and every request's vehicleTypeId is 'v1' — mirror that so the
  // accept-time vehicle-eligibility check passes for the scenarios these
  // tests actually construct, without hand-rolling a full fake registry.
  const vehicleOwnerByVehicleId = new Map([
    ['v1', 'd1'],
    ['v2', 'd2'],
  ]);
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
  // The assignment ledger is now consulted alongside `currentDriverId` — the
  // pointer alone is denormalised and can outlive a released assignment.
  const vehicleAssignmentRepository = {
    async findActiveForDriver(driverId: string) {
      for (const [vehicleId, owner] of vehicleOwnerByVehicleId) {
        if (owner === driverId) return { driverId, vehicleId, status: 'ACTIVE' };
      }
      return null;
    },
  };
  // The real service is used rather than a stub: accept-time eligibility is
  // exactly the behaviour these concurrency tests must not silently lose.
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

  const service = new LifecycleService(
    rideRepo as never,
    requestRepo as never,
    {
      async record(e: { toStatus: string }) {
        statusEvents.push(e.toStatus);
      },
    } as never,
    dispatchRepo as never,
    {
      async generateStartOtp() {
        return { plaintextOtp: '123456' };
      },
    } as never,
    // PricingRuleRepository's real contract. Returning null for both the city
    // and the 'GLOBAL' lookup makes `rateCardForTypeId` fall back to the
    // default config rate card — the same deterministic pricing this suite
    // relied on when it stubbed the old VehicleTypeRepository's `findById`.
    // The stub tracks the pricing repository interface; it must not be
    // narrowed to whatever the service happens to call today.
    new PricingService({
      async findActiveRule() {
        return null;
      },
    } as never),
    {
      async create(f: { rideId: string }) {
        fares.push(f.rideId);
        return f;
      },
    } as never,
    {
      async processCancellation() {
        return {};
      },
    } as never,

    {
      async recordTripPayment(input: { rideId: string }) {
        ledgerPostings.push(input.rideId);
        return [];
      },
    } as never,
    driverStatusRepository as never,
    driverRepository as never,
    userRepository as never,
    notificationService as never,
    vehicleRepository as never,
    vehicleAssignmentRepository as never,
    vehicleEligibilityService,
    {
      async execute<T>(fn: (tx: unknown) => Promise<T>) {
        return fn({});
      },
    } as never,
    {
      async publish(e: { type?: string }) {
        events.push(e?.type ?? 'event');
      },
    } as never,
    { rideStarted() {}, rideCompleted() {}, rideCancelled() {}, driverArriving() {} } as never,
  );

  /// Puts a live PENDING offer in front of a driver, the way a dispatch round
  /// would. Accepting without one is now refused, so every accept path a test
  /// exercises has to start here.
  function offer(
    requestId: string,
    driverId: string,
    overrides: Record<string, unknown> = {},
  ): void {
    offers.set(`${requestId}:${driverId}`, {
      id: `dsp_${offers.size + 1}`,
      requestId,
      driverId,
      response: 'PENDING',
      expiresAt: new Date(Date.now() + 30_000),
      ...overrides,
    });
  }

  return {
    service,
    offer,
    offers,
    driverStatusById,
    rides,
    requests,
    fares,
    statusEvents,
    events,
    ledgerPostings,
    resolvedOffers,
    driverStatuses,
    activeRideByDriver,
    sentOtpSms,
  };
}

function seedRide(world: ReturnType<typeof makeWorld>, status: string) {
  world.rides.set('ride_1', {
    id: 'ride_1',
    status,
    driverId: 'driver_1',
    customerId: 'cust_1',
    vehicleTypeId: 'v1',
    paymentMethod: 'CASH',
    waitTimeMin: 0,
  });
}

describe('Ride lifecycle concurrency', () => {
  it('lets exactly one of two drivers win the same request', async () => {
    const world = makeWorld();
    world.requests.set('req_1', {
      id: 'req_1',
      status: 'SEARCHING',
      customerId: 'cust_1',
      vehicleTypeId: 'v1',
      pickupLat: 1,
      pickupLng: 1,
    });
    // A parallel dispatch round: both drivers hold a live offer for the same
    // request, which is exactly the race the batch size introduces.
    world.offer('req_1', 'd1');
    world.offer('req_1', 'd2');

    const settled = await Promise.allSettled([
      world.service.acceptRideRequest({ requestId: 'req_1', driverId: 'd1', vehicleId: 'v1' }),
      world.service.acceptRideRequest({ requestId: 'req_1', driverId: 'd2', vehicleId: 'v2' }),
    ]);

    const won = settled.filter((r) => r.status === 'fulfilled');
    const lost = settled.filter((r) => r.status === 'rejected');

    assert.equal(won.length, 1, 'exactly one driver may be assigned');
    assert.equal(lost.length, 1);
    assert.ok((lost[0] as PromiseRejectedResult).reason instanceof RideRequestAlreadyMatchedError);
    assert.equal(world.rides.size, 1, 'only one ride row may exist for one request');
  });

  /// A driver holds the `customer` role like everybody else — `ensureDefaultRole`
  /// grants it on every phone login — so nothing on the booking route can stop
  /// one from requesting a ride, and dispatch will happily offer that request
  /// back to them as the nearest online driver to their own pickup point.
  /// Accepting is where it has to be refused, because accepting is what mints
  /// the ride, the fare and the driver earning.
  it('refuses a driver accepting the request they booked themselves', async () => {
    const world = makeWorld();
    world.requests.set('req_1', {
      id: 'req_1',
      status: 'SEARCHING',
      customerId: 'user_of_d1',
      vehicleTypeId: 'v1',
      pickupLat: 1,
      pickupLng: 1,
    });
    world.offer('req_1', 'd1');

    await assert.rejects(
      world.service.acceptRideRequest({ requestId: 'req_1', driverId: 'd1', vehicleId: 'v1' }),
      SelfRideNotAllowedError,
    );
    assert.equal(world.rides.size, 0, 'no ride may be created');
    assert.equal(world.fares.length, 0);
    assert.equal(
      world.requests.get('req_1')?.status,
      'SEARCHING',
      'the request must stay open for a real driver',
    );
  });

  it('accepting a request resolves its offers and puts the driver ON_TRIP', async () => {
    const world = makeWorld();
    world.requests.set('req_1', {
      id: 'req_1',
      status: 'SEARCHING',
      customerId: 'cust_1',
      vehicleTypeId: 'v1',
      pickupLat: 1,
      pickupLng: 1,
    });
    world.offer('req_1', 'd1');

    const { plaintextOtp } = await world.service.acceptRideRequest({
      requestId: 'req_1',
      driverId: 'd1',
      vehicleId: 'v1',
    });

    assert.deepEqual(world.resolvedOffers, ['req_1:d1']);
    assert.deepEqual(world.driverStatuses, [{ driverId: 'd1', status: 'ON_TRIP' }]);
    assert.equal(
      world.sentOtpSms.length,
      1,
      'the customer, not the driver, receives the start OTP',
    );
    assert.equal(world.sentOtpSms[0]!.to, '+91cust_1');
    assert.ok(
      world.sentOtpSms[0]!.body.includes(plaintextOtp),
      'the delivered message carries the same code the driver must be given',
    );
  });

  it('refuses to accept with a vehicle that is not currently assigned to the driver', async () => {
    const world = makeWorld();
    world.requests.set('req_1', {
      id: 'req_1',
      status: 'SEARCHING',
      customerId: 'cust_1',
      vehicleTypeId: 'v1',
      pickupLat: 1,
      pickupLng: 1,
    });

    world.offer('req_1', 'd1');

    // v2 is owned by d2, not d1.
    await assert.rejects(
      () =>
        world.service.acceptRideRequest({ requestId: 'req_1', driverId: 'd1', vehicleId: 'v2' }),
      (err: unknown) => (err as { code?: string }).code === 'VEHICLE_MISMATCH',
    );
    assert.equal(world.requests.get('req_1')?.status, 'SEARCHING', 'the request stays claimable');
  });

  it('refuses to let a driver already on a ride accept a second one', async () => {
    const world = makeWorld();
    world.requests.set('req_1', {
      id: 'req_1',
      status: 'SEARCHING',
      customerId: 'cust_1',
      vehicleTypeId: 'v1',
      pickupLat: 1,
      pickupLng: 1,
    });
    world.requests.set('req_2', {
      id: 'req_2',
      status: 'SEARCHING',
      customerId: 'cust_2',
      vehicleTypeId: 'v1',
      pickupLat: 2,
      pickupLng: 2,
    });
    world.offer('req_1', 'd1');
    world.offer('req_2', 'd1');

    await world.service.acceptRideRequest({ requestId: 'req_1', driverId: 'd1', vehicleId: 'v1' });

    await assert.rejects(
      () =>
        world.service.acceptRideRequest({ requestId: 'req_2', driverId: 'd1', vehicleId: 'v1' }),
      (err: unknown) => (err as { code?: string }).code === 'DRIVER_NOT_AVAILABLE',
    );
    // The second request must still be claimable by someone else — a driver
    // who is already busy must not have consumed it on the way to failing.
    assert.equal(world.requests.get('req_2')?.status, 'SEARCHING');
  });

  it('frees the driver back to ONLINE on completion and on cancellation', async () => {
    const worldA = makeWorld();
    seedRide(worldA, 'IN_PROGRESS');
    await worldA.service.completeRide('ride_1', 'driver_1', 12, 25);
    assert.ok(
      worldA.driverStatuses.some((s) => s.driverId === 'driver_1' && s.status === 'ONLINE'),
      'completion must release the driver',
    );

    const worldB = makeWorld();
    seedRide(worldB, 'ACCEPTED');
    await worldB.service.cancelRide('ride_1', 'CUSTOMER', 'cust_1', 'CHANGED_MIND');
    assert.ok(
      worldB.driverStatuses.some((s) => s.driverId === 'driver_1' && s.status === 'ONLINE'),
      'cancellation must release the driver too, regardless of who cancelled',
    );
  });

  it('completes a ride exactly once under two concurrent calls', async () => {
    const world = makeWorld();
    seedRide(world, 'IN_PROGRESS');

    const settled = await Promise.allSettled([
      world.service.completeRide('ride_1', 'driver_1', 12, 25),
      world.service.completeRide('ride_1', 'driver_1', 12, 25),
    ]);

    const fulfilled = settled.filter((r) => r.status === 'fulfilled');
    assert.equal(fulfilled.length, 1, 'exactly one completion may succeed');
    assert.deepEqual(world.fares, ['ride_1'], 'exactly one fare row — no double billing');
    assert.deepEqual(world.statusEvents, ['COMPLETED'], 'exactly one lifecycle event');
    assert.deepEqual(
      world.ledgerPostings,
      ['ride_1'],
      'exactly one ledger posting — the books must not double-count the trip either',
    );
    assert.equal(world.rides.get('ride_1')?.status, 'COMPLETED');
  });

  it('allows only one terminal transition when cancel races complete', async () => {
    const world = makeWorld();
    seedRide(world, 'IN_PROGRESS');

    const settled = await Promise.allSettled([
      world.service.completeRide('ride_1', 'driver_1', 5, 10),
      world.service.cancelRide('ride_1', 'SYSTEM', 'ops_1', 'TIMEOUT'),
    ]);

    const fulfilled = settled.filter((r) => r.status === 'fulfilled');
    assert.equal(fulfilled.length, 1, 'exactly one terminal transition');

    const finalStatus = world.rides.get('ride_1')?.status as string;
    assert.ok(['COMPLETED', 'CANCELLED_BY_SYSTEM'].includes(finalStatus));
    assert.ok(world.fares.length <= 1);
  });

  it('rejects a transition made invalid by another request', async () => {
    const world = makeWorld();
    seedRide(world, 'IN_PROGRESS');

    await world.service.completeRide('ride_1', 'driver_1', 5, 10);

    await assert.rejects(
      () => world.service.markDriverArrived('ride_1', 'driver_1'),
      (err: unknown) => err instanceof InvalidRideStateTransitionError,
    );
  });

  it('refuses a driver acting on another driver’s ride', async () => {
    const world = makeWorld();
    seedRide(world, 'IN_PROGRESS');

    await assert.rejects(
      () => world.service.completeRide('ride_1', 'someone_else', 5, 10),
      (err: unknown) => err instanceof RideDriverMismatchError,
    );
    assert.deepEqual(world.fares, [], 'no fare may be written for a rejected actor');
    assert.deepEqual(world.ledgerPostings, [], 'and nothing may reach the books');
  });

  it('bills the completed ride for its actual distance', async () => {
    const world = makeWorld();
    seedRide(world, 'IN_PROGRESS');

    await world.service.completeRide('ride_1', 'driver_1', 30, 60);
    assert.equal(world.rides.get('ride_1')?.actualDistanceKm?.toString(), '30');
  });

  /// This assertion used to read `actualDurationMin === 60` — the number the
  /// driver's client declared. That was the defect, not the contract: the fare
  /// was computed from a value the client chose. Both ends of a trip are
  /// stamped by the server, so the duration is now measured and the declared
  /// figure decides nothing.
  it('records the duration it measured, not the one the driver declared', async () => {
    const world = makeWorld();
    seedRide(world, 'IN_PROGRESS');
    // A ride that genuinely started 25 minutes ago, reported as 60.
    const startedAt = new Date(Date.now() - 25 * 60_000);
    world.rides.set('ride_1', { ...world.rides.get('ride_1'), startedAt });

    await world.service.completeRide('ride_1', 'driver_1', 30, 60);

    const measured = world.rides.get('ride_1')?.actualDurationMin as number;
    assert.ok(
      measured >= 24 && measured <= 26,
      `expected roughly 25 measured minutes, got ${measured}`,
    );
    assert.notEqual(measured, 60, 'the declared duration must not be what is stored');
  });

  it('rejects a final distance wildly beyond the original quote', async () => {
    const world = makeWorld();
    world.rides.set('ride_1', {
      id: 'ride_1',
      status: 'IN_PROGRESS',
      driverId: 'driver_1',
      customerId: 'cust_1',
      vehicleTypeId: 'v1',
      paymentMethod: 'CASH',
      waitTimeMin: 0,
      requestId: 'req_1',
    });
    world.requests.set('req_1', {
      id: 'req_1',
      status: 'MATCHED',
      customerId: 'cust_1',
      vehicleTypeId: 'v1',
      estimatedDistanceKm: 5,
      estimatedDurationMin: 15,
    });

    await assert.rejects(
      () => world.service.completeRide('ride_1', 'driver_1', 500, 20),
      (err: unknown) => (err as { code?: string }).code === 'IMPLAUSIBLE_TRIP_DATA',
    );
    assert.equal(world.rides.get('ride_1')?.status, 'IN_PROGRESS', 'the ride is untouched');
    assert.deepEqual(world.fares, [], 'no fare was written for the rejected completion');
  });

  it('refuses a customer cancelling someone else’s ride', async () => {
    const world = makeWorld();
    seedRide(world, 'ACCEPTED');

    await assert.rejects(
      () => world.service.cancelRide('ride_1', 'CUSTOMER', 'not-the-customer', 'CHANGED_MIND'),
      (err: unknown) => (err as { code?: string }).code === 'RIDE_CUSTOMER_MISMATCH',
    );
    assert.equal(world.rides.get('ride_1')?.status, 'ACCEPTED', 'ride must be untouched');
  });

  it('allows the real customer to cancel their own ride', async () => {
    const world = makeWorld();
    seedRide(world, 'ACCEPTED');

    await world.service.cancelRide('ride_1', 'CUSTOMER', 'cust_1', 'CHANGED_MIND');
    assert.equal(world.rides.get('ride_1')?.status, 'CANCELLED_BY_CUSTOMER');
  });

  it('refuses a driver cancelling a ride they are not assigned to', async () => {
    const world = makeWorld();
    seedRide(world, 'ACCEPTED');

    await assert.rejects(
      () => world.service.cancelRide('ride_1', 'DRIVER', 'other_driver', 'BREAKDOWN'),
      (err: unknown) => (err as { code?: string }).code === 'RIDE_DRIVER_MISMATCH',
    );
    assert.equal(world.rides.get('ride_1')?.status, 'ACCEPTED');
  });

  it('requires an actor for a party-initiated cancellation', async () => {
    const world = makeWorld();
    seedRide(world, 'ACCEPTED');

    await assert.rejects(
      () => world.service.cancelRide('ride_1', 'CUSTOMER', undefined, 'CHANGED_MIND'),
      (err: unknown) => (err as { code?: string }).code === 'RIDE_ACTOR_REQUIRED',
    );
  });

  it('still lets a SYSTEM cancellation act without an actor', async () => {
    const world = makeWorld();
    seedRide(world, 'ACCEPTED');

    await world.service.cancelRide('ride_1', 'SYSTEM', undefined, 'TIMEOUT');
    assert.equal(world.rides.get('ride_1')?.status, 'CANCELLED_BY_SYSTEM');
  });

  it('leaves a non-cash ride unpaid until payments settles it', async () => {
    const world = makeWorld();
    world.rides.set('ride_1', {
      id: 'ride_1',
      status: 'IN_PROGRESS',
      driverId: 'driver_1',
      customerId: 'cust_1',
      vehicleTypeId: 'v1',
      paymentMethod: 'CARD',
      waitTimeMin: 0,
    });

    await world.service.completeRide('ride_1', 'driver_1', 10, 20);

    assert.equal(world.rides.get('ride_1')?.paymentStatus, 'PENDING');
  });

  describe('the offer gate on accept', () => {
    function searchingRequest(world: ReturnType<typeof makeWorld>) {
      world.requests.set('req_1', {
        id: 'req_1',
        status: 'SEARCHING',
        customerId: 'cust_1',
        vehicleTypeId: 'v1',
        pickupLat: 1,
        pickupLng: 1,
      });
    }

    it('refuses a driver who was never offered the request', async () => {
      const world = makeWorld();
      searchingRequest(world);

      await assert.rejects(
        () =>
          world.service.acceptRideRequest({ requestId: 'req_1', driverId: 'd1', vehicleId: 'v1' }),
        (err: unknown) => (err as { code?: string }).code === 'RIDE_OFFER_NOT_FOUND',
      );
      assert.equal(world.requests.get('req_1')?.status, 'SEARCHING', 'nothing may be claimed');
      assert.equal(world.rides.size, 0);
    });

    it('refuses an offer whose window has passed', async () => {
      const world = makeWorld();
      searchingRequest(world);
      world.offer('req_1', 'd1', { expiresAt: new Date(Date.now() - 1000) });

      await assert.rejects(
        () =>
          world.service.acceptRideRequest({ requestId: 'req_1', driverId: 'd1', vehicleId: 'v1' }),
        (err: unknown) => (err as { code?: string }).code === 'RIDE_OFFER_NOT_ACTIONABLE',
      );
      assert.equal(world.rides.size, 0);
    });

    for (const response of ['TIMEOUT', 'REJECTED', 'CANCELLED', 'ACCEPTED'] as const) {
      it(`refuses an offer already resolved as ${response}`, async () => {
        const world = makeWorld();
        searchingRequest(world);
        world.offer('req_1', 'd1', { response });

        await assert.rejects(
          () =>
            world.service.acceptRideRequest({
              requestId: 'req_1',
              driverId: 'd1',
              vehicleId: 'v1',
            }),
          (err: unknown) => (err as { code?: string }).code === 'RIDE_OFFER_NOT_ACTIONABLE',
        );
        assert.equal(world.rides.size, 0);
      });
    }

    it('closes the loser’s offer so it can never be accepted afterwards', async () => {
      const world = makeWorld();
      searchingRequest(world);
      world.offer('req_1', 'd1');
      world.offer('req_1', 'd2');

      await world.service.acceptRideRequest({
        requestId: 'req_1',
        driverId: 'd1',
        vehicleId: 'v1',
      });

      assert.equal(world.offers.get('req_1:d2')?.response, 'CANCELLED');
      // The losing driver arriving late must be turned away by the offer, not
      // only by the request status — both gates matter, and this is the one
      // that names what actually happened to them.
      await assert.rejects(
        () =>
          world.service.acceptRideRequest({ requestId: 'req_1', driverId: 'd2', vehicleId: 'v2' }),
        (err: unknown) => (err as { code?: string }).code === 'RIDE_OFFER_NOT_ACTIONABLE',
      );
      assert.equal(world.rides.size, 1);
    });

    it('refuses a driver who went offline after the offer landed', async () => {
      const world = makeWorld();
      searchingRequest(world);
      world.offer('req_1', 'd1');
      world.driverStatusById.set('d1', 'OFFLINE');

      await assert.rejects(
        () =>
          world.service.acceptRideRequest({ requestId: 'req_1', driverId: 'd1', vehicleId: 'v1' }),
        (err: unknown) => (err as { code?: string }).code === 'DRIVER_NOT_AVAILABLE',
      );
      assert.equal(world.requests.get('req_1')?.status, 'SEARCHING', 'still claimable by others');
    });
  });

  describe('DRIVER_ARRIVING', () => {
    it('moves an accepted ride to DRIVER_ARRIVING and emits the event', async () => {
      const world = makeWorld();
      seedRide(world, 'ACCEPTED');

      const ride = await world.service.markDriverArriving('ride_1', 'driver_1');

      assert.equal(ride.status, 'DRIVER_ARRIVING');
      assert.equal(world.rides.get('ride_1')?.status, 'DRIVER_ARRIVING');
      assert.ok(world.statusEvents.includes('DRIVER_ARRIVING'));
      assert.ok(world.events.includes('ride.driver_arriving'));
    });

    it('still allows the existing straight-to-arrived shortcut', async () => {
      const world = makeWorld();
      seedRide(world, 'ACCEPTED');

      await world.service.markDriverArrived('ride_1', 'driver_1');
      assert.equal(world.rides.get('ride_1')?.status, 'DRIVER_ARRIVED');
    });

    it('goes on to DRIVER_ARRIVED from DRIVER_ARRIVING', async () => {
      const world = makeWorld();
      seedRide(world, 'ACCEPTED');

      await world.service.markDriverArriving('ride_1', 'driver_1');
      await world.service.markDriverArrived('ride_1', 'driver_1');
      assert.equal(world.rides.get('ride_1')?.status, 'DRIVER_ARRIVED');
    });

    it('refuses a driver who is not the one assigned', async () => {
      const world = makeWorld();
      seedRide(world, 'ACCEPTED');

      await assert.rejects(
        () => world.service.markDriverArriving('ride_1', 'someone_else'),
        (err: unknown) => err instanceof RideDriverMismatchError,
      );
      assert.equal(world.rides.get('ride_1')?.status, 'ACCEPTED');
    });

    it('refuses to go back to DRIVER_ARRIVING once in progress', async () => {
      const world = makeWorld();
      seedRide(world, 'IN_PROGRESS');

      await assert.rejects(
        () => world.service.markDriverArriving('ride_1', 'driver_1'),
        (err: unknown) => err instanceof InvalidRideStateTransitionError,
      );
    });

    it('applies the transition exactly once under two concurrent calls', async () => {
      const world = makeWorld();
      seedRide(world, 'ACCEPTED');

      const settled = await Promise.allSettled([
        world.service.markDriverArriving('ride_1', 'driver_1'),
        world.service.markDriverArriving('ride_1', 'driver_1'),
      ]);

      assert.equal(settled.filter((r) => r.status === 'fulfilled').length, 1);
      assert.deepEqual(world.statusEvents, ['DRIVER_ARRIVING'], 'exactly one lifecycle event');
    });
  });
});

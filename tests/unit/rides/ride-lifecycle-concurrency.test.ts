import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LifecycleService } from '../../../src/modules/rides/services/lifecycle/lifecycle.service.js';
import { FareService } from '../../../src/modules/rides/services/fare/fare.service.js';
import {
  InvalidRideStateTransitionError,
  RideDriverMismatchError,
  RideRequestAlreadyMatchedError,
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
    async claimForMatch(id: string) {
      const request = requests.get(id);
      if (!request || !['CREATED', 'SEARCHING'].includes(request.status as string)) return false;
      requests.set(id, { ...request, status: 'MATCHED' });
      return true;
    },
  };

  const dispatchRepo = {
    async resolveOffers(requestId: string, winningDriverId: string) {
      resolvedOffers.push(`${requestId}:${winningDriverId}`);
    },
  };

  const driverStatusRepository = {
    async updateStatus(driverId: string, status: string) {
      driverStatuses.push({ driverId, status });
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
    new FareService(),
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
    userRepository as never,
    notificationService as never,
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
    { rideStarted() {}, rideCompleted() {}, rideCancelled() {} } as never,
  );

  return {
    service,
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
    assert.equal(world.rides.get('ride_1')?.actualDurationMin, 60);
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
});

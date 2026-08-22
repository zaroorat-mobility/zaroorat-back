import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DispatchService } from '../../../src/modules/rides/services/dispatch/dispatch.service.js';
import { rideConfig } from '../../../src/config/ride/ride.config.js';

interface Offer {
  id: string;
  requestId: string;
  driverId: string;
  response: string;
  respondedAt: Date | null;
  rejectReason: string | null;
  dispatchRound: number;
  expiresAt: Date | null;
}

/// A dispatch world small enough to reason about: an in-memory offer table with
/// the same [requestId, driverId] uniqueness the database enforces, a real
/// token-based lock so contention behaves the way Redis does, and a candidate
/// pool that can be reordered to check geographic ranking survives.
function makeWorld(
  options: { candidates?: string[]; requestStatus?: string; requestExpiresAt?: Date | null } = {},
) {
  const offers = new Map<string, Offer>();
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const metrics: string[] = [];
  const heldLocks = new Map<string, string>();
  let pool = options.candidates ?? ['drv_a', 'drv_b', 'drv_c', 'drv_d', 'drv_e'];

  const request = {
    id: 'req_1',
    status: options.requestStatus ?? 'SEARCHING',
    pickupLat: 12.9716,
    pickupLng: 77.5946,
    expiresAt: options.requestExpiresAt === undefined ? null : options.requestExpiresAt,
  };

  const key = (requestId: string, driverId: string) => `${requestId}:${driverId}`;

  const dispatchRepo = {
    async createOffer(data: {
      requestId: string;
      driverId: string;
      dispatchRound: number;
      expiresAt?: Date | null;
    }) {
      const k = key(data.requestId, data.driverId);
      // The real table is unique on [requestId, driverId]; a second offer to the
      // same driver must fail here exactly as it would there.
      if (offers.has(k)) throw new Error('duplicate offer for [requestId, driverId]');
      const offer: Offer = {
        id: `dsp_${offers.size + 1}`,
        requestId: data.requestId,
        driverId: data.driverId,
        response: 'PENDING',
        respondedAt: null,
        rejectReason: null,
        dispatchRound: data.dispatchRound,
        expiresAt: data.expiresAt ?? null,
      };
      offers.set(k, offer);
      return offer;
    },
    async findAllDriverIdsForRequest(requestId: string) {
      return [...offers.values()]
        .filter((offer) => offer.requestId === requestId)
        .map((offer) => offer.driverId);
    },
    async countLiveOffers(requestId: string) {
      const now = Date.now();
      return [...offers.values()].filter(
        (offer) =>
          offer.requestId === requestId &&
          offer.response === 'PENDING' &&
          (offer.expiresAt === null || offer.expiresAt.getTime() > now),
      ).length;
    },
    async highestRound(requestId: string) {
      return [...offers.values()]
        .filter((offer) => offer.requestId === requestId)
        .reduce((max, offer) => Math.max(max, offer.dispatchRound), 0);
    },
    async lockForUpdate(id: string) {
      const offer = [...offers.values()].find((candidate) => candidate.id === id);
      return offer ? { ...offer } : null;
    },
    async respondIfPending(id: string, response: string, rejectReason?: string) {
      const offer = [...offers.values()].find((candidate) => candidate.id === id);
      if (!offer || offer.response !== 'PENDING') return false;
      offer.response = response;
      offer.respondedAt = new Date();
      if (rejectReason !== undefined) offer.rejectReason = rejectReason;
      return true;
    },
  };

  const requestRepo = {
    async findById(id: string) {
      return id === request.id ? { ...request } : null;
    },
    async updateStatus(id: string, status: string) {
      if (id === request.id) request.status = status;
      return { ...request };
    },
  };

  const matchingCalls: { excluded: string[]; limit: number }[] = [];
  const matchingService = {
    async findEligibleCandidates(_origin: unknown, excluded: readonly string[], limit: number) {
      matchingCalls.push({ excluded: [...excluded], limit });
      const excludedSet = new Set(excluded);
      return pool
        .filter((driverId) => !excludedSet.has(driverId))
        .slice(0, limit)
        .map((driverId, index) => ({ driverId, distanceMeters: 100 * (index + 1) }));
    },
  };

  const redis = {
    lock: {
      async acquire(resource: string) {
        if (heldLocks.has(resource)) return null;
        const token = `tok_${resource}_${Math.random()}`;
        heldLocks.set(resource, token);
        return token;
      },
      async release(resource: string, token: string) {
        if (heldLocks.get(resource) !== token) return false;
        heldLocks.delete(resource);
        return true;
      },
    },
  };

  const service = new DispatchService(
    dispatchRepo as never,
    requestRepo as never,
    matchingService as never,
    redis as never,
    {
      async execute<T>(fn: (tx: unknown) => Promise<T>) {
        return fn({});
      },
    } as never,
    {
      async publish(event: { type: string; data: Record<string, unknown> }) {
        events.push({ type: event.type, data: event.data });
      },
    } as never,
    {
      dispatchOffered() {
        metrics.push('offered');
      },
      dispatchRejected() {
        metrics.push('rejected');
      },
    } as never,
  );

  return {
    service,
    offers,
    events,
    metrics,
    request,
    heldLocks,
    matchingCalls,
    setPool(next: string[]) {
      pool = next;
    },
    offersFor(requestId: string) {
      return [...offers.values()].filter((offer) => offer.requestId === requestId);
    },
  };
}

describe('Dispatch offers', () => {
  describe('parallel dispatch', () => {
    it('offers one request to a whole batch of drivers in a single round', async () => {
      const world = makeWorld();

      const offered = await world.service.dispatchNextBatch('req_1', 3);

      assert.equal(offered, 3);
      const created = world.offersFor('req_1');
      assert.equal(created.length, 3);
      assert.deepEqual(
        created.map((offer) => offer.driverId),
        ['drv_a', 'drv_b', 'drv_c'],
        'nearest first — the geographic ranking must survive batching',
      );
      assert.ok(
        created.every((offer) => offer.dispatchRound === 1 && offer.response === 'PENDING'),
        'one round, all live',
      );
    });

    it('honours the configured batch size by default', async () => {
      const world = makeWorld();
      await world.service.dispatchNextBatch('req_1');
      assert.equal(world.offersFor('req_1').length, rideConfig.dispatchBatchSize);
    });

    it('collapses to the original one-at-a-time behaviour at a batch size of 1', async () => {
      const world = makeWorld();
      assert.equal(await world.service.dispatchNextBatch('req_1', 1), 1);
    });

    it('never re-offers a driver who already had this request', async () => {
      const world = makeWorld();

      await world.service.dispatchNextBatch('req_1', 2);
      // Free one slot the way a timeout would, so the next round has room.
      world.offers.get('req_1:drv_a')!.response = 'TIMEOUT';
      const second = await world.service.dispatchNextBatch('req_1', 2);

      assert.equal(second, 1);
      const drivers = world.offersFor('req_1').map((offer) => offer.driverId);
      assert.deepEqual(drivers, ['drv_a', 'drv_b', 'drv_c']);
      assert.equal(new Set(drivers).size, drivers.length, 'nobody may be asked twice');
      assert.deepEqual(world.matchingCalls[1]?.excluded, ['drv_a', 'drv_b']);
    });

    it('offers nothing while the batch is already full', async () => {
      const world = makeWorld();

      assert.equal(await world.service.dispatchNextBatch('req_1', 2), 2);
      assert.equal(
        await world.service.dispatchNextBatch('req_1', 2),
        0,
        'two drivers already hold a live offer — a second round has no room',
      );
      assert.equal(world.offersFor('req_1').length, 2);
    });

    it('tops the batch back up as offers fall away, never beyond it', async () => {
      const world = makeWorld();
      await world.service.dispatchNextBatch('req_1', 3);
      world.offers.get('req_1:drv_a')!.response = 'REJECTED';

      assert.equal(await world.service.dispatchNextBatch('req_1', 3), 1, 'one slot, one offer');
      const live = world.offersFor('req_1').filter((offer) => offer.response === 'PENDING').length;
      assert.equal(live, 3, 'never more than the configured batch size are live at once');
    });

    it('increments the dispatch round each time', async () => {
      const world = makeWorld();
      await world.service.dispatchNextBatch('req_1', 2);
      world.offers.get('req_1:drv_a')!.response = 'TIMEOUT';
      await world.service.dispatchNextBatch('req_1', 2);

      const rounds = world.offersFor('req_1').map((offer) => offer.dispatchRound);
      assert.deepEqual(rounds, [1, 1, 2]);
    });

    it('stops when the pool of eligible drivers runs dry', async () => {
      const world = makeWorld({ candidates: ['drv_a'] });

      assert.equal(await world.service.dispatchNextBatch('req_1', 3), 1);
      assert.equal(await world.service.dispatchNextBatch('req_1', 3), 0);
      assert.equal(world.offersFor('req_1').length, 1);
    });

    it('promotes a CREATED request to SEARCHING once someone has been asked', async () => {
      const world = makeWorld({ requestStatus: 'CREATED' });
      await world.service.dispatchNextBatch('req_1', 2);
      assert.equal(world.request.status, 'SEARCHING');
    });

    it('leaves a CREATED request alone when nobody was eligible', async () => {
      const world = makeWorld({ requestStatus: 'CREATED', candidates: [] });
      assert.equal(await world.service.dispatchNextBatch('req_1', 2), 0);
      assert.equal(world.request.status, 'CREATED');
    });

    for (const status of ['MATCHED', 'ABANDONED', 'EXPIRED'] as const) {
      it(`dispatches nothing for a request that is already ${status}`, async () => {
        const world = makeWorld({ requestStatus: status });
        assert.equal(await world.service.dispatchNextBatch('req_1', 3), 0);
        assert.equal(world.offersFor('req_1').length, 0);
      });
    }

    it('dispatches nothing for a request that has aged out', async () => {
      const world = makeWorld({ requestExpiresAt: new Date(Date.now() - 1000) });
      assert.equal(await world.service.dispatchNextBatch('req_1', 3), 0);
    });

    it('dispatches nothing for a request that no longer exists', async () => {
      const world = makeWorld();
      assert.equal(await world.service.dispatchNextBatch('req_gone', 3), 0);
    });

    it('lets only one of two simultaneous rounds run, and releases the lock after', async () => {
      const world = makeWorld();

      const [first, second] = await Promise.all([
        world.service.dispatchNextBatch('req_1', 2),
        world.service.dispatchNextBatch('req_1', 2),
      ]);

      // One round did the work; the other found the request locked and skipped
      // rather than duplicating offers or queueing behind it.
      assert.deepEqual([first, second].sort(), [0, 2]);
      assert.equal(world.offersFor('req_1').length, 2);
      assert.equal(world.heldLocks.size, 0, 'the lock must not leak');
    });

    it('sets the offer window from the configured dispatch timeout', async () => {
      const world = makeWorld();
      const before = Date.now();
      await world.service.dispatchNextBatch('req_1', 1);

      const expiresAt = world.offersFor('req_1')[0]!.expiresAt!.getTime();
      const expected = before + rideConfig.dispatchTimeoutSeconds * 1000;
      assert.ok(
        Math.abs(expiresAt - expected) < 2000,
        `offer window ${expiresAt - before}ms should track RIDE_DISPATCH_TIMEOUT_SEC`,
      );
    });

    it('publishes an offered event carrying the ids a notifier needs', async () => {
      const world = makeWorld();
      await world.service.dispatchNextBatch('req_1', 1);

      const offered = world.events.filter((event) => event.type === 'ride.dispatch.offered');
      assert.equal(offered.length, 1);
      assert.equal(offered[0]!.data.requestId, 'req_1');
      assert.equal(offered[0]!.data.driverId, 'drv_a');
      assert.equal(typeof offered[0]!.data.dispatchId, 'string');
    });
  });

  describe('driver reject', () => {
    async function offeredWorld() {
      const world = makeWorld();
      await world.service.dispatchNextBatch('req_1', 1);
      return { world, offer: world.offersFor('req_1')[0]! };
    }

    it('records the rejection with its reason and publishes the event', async () => {
      const { world, offer } = await offeredWorld();

      const rejected = await world.service.rejectOffer({
        dispatchId: offer.id,
        driverId: 'drv_a',
        reason: 'TOO_FAR',
      });

      assert.equal(rejected.response, 'REJECTED');
      assert.equal(world.offers.get('req_1:drv_a')?.response, 'REJECTED');
      assert.equal(world.offers.get('req_1:drv_a')?.rejectReason, 'TOO_FAR');
      assert.ok(world.events.some((event) => event.type === 'ride.dispatch.rejected'));
      assert.ok(world.metrics.includes('rejected'));
    });

    it('advances dispatch immediately instead of waiting for the timeout job', async () => {
      const { world, offer } = await offeredWorld();

      await world.service.rejectOffer({ dispatchId: offer.id, driverId: 'drv_a' });

      const drivers = world.offersFor('req_1').map((entry) => entry.driverId);
      assert.equal(drivers[0], 'drv_a');
      assert.ok(drivers.length > 1, 'the next driver was asked on the spot');
      assert.equal(world.offersFor('req_1')[1]!.dispatchRound, 2);
      assert.ok(
        world.offersFor('req_1').filter((entry) => entry.response === 'PENDING').length <=
          rideConfig.dispatchBatchSize,
        'and the top-up respected the configured ceiling',
      );
    });

    it('excludes the rejecting driver from every later round', async () => {
      const { world, offer } = await offeredWorld();

      await world.service.rejectOffer({ dispatchId: offer.id, driverId: 'drv_a' });
      await world.service.dispatchNextBatch('req_1', 5);

      const drivers = world.offersFor('req_1').map((entry) => entry.driverId);
      assert.equal(drivers.filter((id) => id === 'drv_a').length, 1, 'never re-offered');
    });

    it('is idempotent — a second rejection changes nothing and re-dispatches nothing', async () => {
      const { world, offer } = await offeredWorld();

      await world.service.rejectOffer({ dispatchId: offer.id, driverId: 'drv_a' });
      const countAfterFirst = world.offersFor('req_1').length;
      const again = await world.service.rejectOffer({ dispatchId: offer.id, driverId: 'drv_a' });

      assert.equal(again.response, 'REJECTED');
      assert.equal(
        world.offersFor('req_1').length,
        countAfterFirst,
        'a retried reject must not kick off another round',
      );
      assert.equal(
        world.events.filter((event) => event.type === 'ride.dispatch.rejected').length,
        1,
        'nor publish the event twice',
      );
    });

    it('refuses to let a driver reject somebody else’s offer', async () => {
      const { world, offer } = await offeredWorld();

      await assert.rejects(
        () => world.service.rejectOffer({ dispatchId: offer.id, driverId: 'drv_z' }),
        (err: unknown) => (err as { code?: string }).code === 'RIDE_OFFER_MISMATCH',
      );
      assert.equal(world.offers.get('req_1:drv_a')?.response, 'PENDING');
    });

    it('404s on an offer that does not exist', async () => {
      const world = makeWorld();
      await assert.rejects(
        () => world.service.rejectOffer({ dispatchId: 'dsp_nope', driverId: 'drv_a' }),
        (err: unknown) => (err as { code?: string }).code === 'RIDE_OFFER_NOT_FOUND',
      );
    });

    for (const response of ['ACCEPTED', 'CANCELLED', 'TIMEOUT'] as const) {
      it(`refuses to reject an offer already resolved as ${response}`, async () => {
        const { world, offer } = await offeredWorld();
        world.offers.get('req_1:drv_a')!.response = response;

        await assert.rejects(
          () => world.service.rejectOffer({ dispatchId: offer.id, driverId: 'drv_a' }),
          (err: unknown) => (err as { code?: string }).code === 'RIDE_OFFER_NOT_ACTIONABLE',
        );
        assert.equal(
          world.offers.get('req_1:drv_a')?.response,
          response,
          'a decision already made must not be overwritten',
        );
      });
    }

    it('still accepts a rejection for an offer the timeout job has not swept yet', async () => {
      const { world, offer } = await offeredWorld();
      world.offers.get('req_1:drv_a')!.expiresAt = new Date(Date.now() - 5000);

      const rejected = await world.service.rejectOffer({
        dispatchId: offer.id,
        driverId: 'drv_a',
      });
      assert.equal(rejected.response, 'REJECTED');
    });

    it('does not re-dispatch when the request was taken while the driver was deciding', async () => {
      const { world, offer } = await offeredWorld();
      world.request.status = 'MATCHED';

      await world.service.rejectOffer({ dispatchId: offer.id, driverId: 'drv_a' });

      assert.equal(world.offers.get('req_1:drv_a')?.response, 'REJECTED');
      assert.equal(world.offersFor('req_1').length, 1, 'nobody else may be asked');
    });

    it('does not re-dispatch when the customer cancelled while the driver was deciding', async () => {
      const { world, offer } = await offeredWorld();
      world.request.status = 'ABANDONED';

      await world.service.rejectOffer({ dispatchId: offer.id, driverId: 'drv_a' });
      assert.equal(world.offersFor('req_1').length, 1);
    });

    it('lets two drivers in the same batch each reject without disturbing the other', async () => {
      const world = makeWorld();
      await world.service.dispatchNextBatch('req_1', 2);
      const [first, second] = world.offersFor('req_1');

      await world.service.rejectOffer({ dispatchId: first!.id, driverId: first!.driverId });
      await world.service.rejectOffer({ dispatchId: second!.id, driverId: second!.driverId });

      assert.equal(world.offers.get(`req_1:${first!.driverId}`)?.response, 'REJECTED');
      assert.equal(world.offers.get(`req_1:${second!.driverId}`)?.response, 'REJECTED');
      const drivers = world.offersFor('req_1').map((entry) => entry.driverId);
      assert.equal(new Set(drivers).size, drivers.length, 'no duplicate offers anywhere');
    });
  });
});

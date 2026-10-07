import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RideDispatchRepository } from '../../../src/modules/rides/repositories/ride-dispatch.repository.js';
import { DispatchService } from '../../../src/modules/rides/services/dispatch/dispatch.service.js';
import { rideConfig } from '../../../src/config/ride/ride.config.js';

describe('Dispatch counters and limits tests (Step 3)', () => {
  describe('offer stats counters (Passed / Notified)', () => {
    it('rejection and timeout both increment Passed; cancelled offers do not', async () => {
      // Mock db client groupBy returning counts by response
      const mockGroups = [
        { response: 'PENDING', _count: { _all: 2 } },
        { response: 'REJECTED', _count: { _all: 3 } },
        { response: 'TIMEOUT', _count: { _all: 4 } },
        { response: 'CANCELLED', _count: { _all: 5 } }, // e.g. cancelled because another driver accepted
      ];

      const mockDb = {
        client: {
          rideDispatch: {
            groupBy: async () => mockGroups,
          },
        },
      };

      const repo = new RideDispatchRepository(mockDb as never);
      const stats = await repo.countOfferStatsForRequest('req-1');

      // sent = PENDING(2) + REJECTED(3) + TIMEOUT(4) = 9 (CANCELLED is excluded)
      assert.equal(stats.offersSent, 9);
      assert.equal(stats.driversNotified, 9);

      // rejected/passed = REJECTED(3) + TIMEOUT(4) = 7 (CANCELLED does not count as Passed)
      assert.equal(stats.offersRejected, 7);
      assert.equal(stats.driversRejected, 7);
    });
  });

  describe('dispatch limits enforce stopping cleanly', () => {
    function createDispatchHarness(options: {
      highestRound?: number;
      alreadyOffered?: string[];
      liveOffers?: number;
      candidates?: string[];
      requestStatus?: string;
    }) {
      const events: Array<{ type: string; data: Record<string, unknown> }> = [];
      let requestStatus = options.requestStatus ?? 'SEARCHING';
      const alreadyOffered = options.alreadyOffered ? [...options.alreadyOffered] : [];
      let highestRound = options.highestRound ?? 0;
      let liveOffers = options.liveOffers ?? 0;

      const mockDispatchRepo = {
        async countLiveOffers() {
          return liveOffers;
        },
        async findAllDriverIdsForRequest() {
          return alreadyOffered;
        },
        async highestRound() {
          return highestRound;
        },
        async createOffer(input: {
          driverId: string;
          dispatchRound: number;
          [key: string]: unknown;
        }) {
          alreadyOffered.push(input.driverId);
          highestRound = Math.max(highestRound, input.dispatchRound);
          liveOffers++;
          return { id: `disp-${input.driverId}`, ...input };
        },
      };

      const mockRequestRepo = {
        async findById() {
          return {
            id: 'req-1',
            status: requestStatus,
            customerId: 'cust-1',
            vehicleTypeId: 'v-1',
            pickupLat: 28.6,
            pickupLng: 77.2,
          };
        },
        async updateStatus(_id: string, s: string) {
          requestStatus = s;
          return { id: 'req-1', status: s };
        },
      };

      const mockMatchingService = {
        async findEligibleCandidates(_origin: unknown, _excluded: unknown, limit: number) {
          const c = options.candidates ?? [];
          return c.slice(0, limit).map((d, i) => ({ driverId: d, distanceMeters: 100 * (i + 1) }));
        },
      };

      const mockRedis = {
        lock: {
          acquire: async () => 'tok-1',
          release: async () => true,
        },
      };

      const mockTxManager = {
        execute: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({}),
      };

      const mockEventPublisher = {
        publish: async (event: { type: string; data: Record<string, unknown> }) => {
          events.push(event);
        },
      };

      const service = new DispatchService(
        mockDispatchRepo as never,
        mockRequestRepo as never,
        mockMatchingService as never,
        mockRedis as never,
        mockTxManager as never,
        mockEventPublisher as never,
        { dispatchOffered: () => {}, dispatchRejected: () => {} } as never,
      );

      return {
        service,
        getEvents: () => events,
        getRequestStatus: () => requestStatus,
      };
    }

    it('stops dispatch and expires request when max rounds reached and no live offers remain', async () => {
      // Config max rounds is 5. If highestRound is already 5, next round would be 6 (> 5).
      const harness = createDispatchHarness({
        highestRound: rideConfig.dispatchMaxRounds,
        liveOffers: 0,
        candidates: ['d-extra'],
      });

      const offered = await harness.service.dispatchNextBatch('req-1', 3);
      assert.equal(offered, 0);
      assert.equal(harness.getRequestStatus(), 'EXPIRED');
      assert.ok(harness.getEvents().some((e) => e.type === 'ride.request.expired'));
    });

    it('stops dispatch and expires request when max attempted drivers reached and no live offers remain', async () => {
      // Simulate already offered to max drivers (default 20)
      const maxDrivers = Array.from(
        { length: rideConfig.dispatchMaxAttemptedDrivers },
        (_, i) => `d-${i}`,
      );
      const harness = createDispatchHarness({
        highestRound: 1,
        alreadyOffered: maxDrivers,
        liveOffers: 0,
        candidates: ['d-extra'],
      });

      const offered = await harness.service.dispatchNextBatch('req-1', 3);
      assert.equal(offered, 0);
      assert.equal(harness.getRequestStatus(), 'EXPIRED');
      assert.ok(harness.getEvents().some((e) => e.type === 'ride.request.expired'));
    });

    it('clamps remaining available slots when near max attempted drivers', async () => {
      // 19 already offered, limit is 20 -> only 1 slot should be offered even if batchSize is 3
      const almostMax = Array.from(
        { length: rideConfig.dispatchMaxAttemptedDrivers - 1 },
        (_, i) => `d-${i}`,
      );
      const harness = createDispatchHarness({
        highestRound: 1,
        alreadyOffered: almostMax,
        liveOffers: 0,
        candidates: ['d-new1', 'd-new2', 'd-new3'],
      });

      const offered = await harness.service.dispatchNextBatch('req-1', 3);
      assert.equal(offered, 1);
    });
  });
});

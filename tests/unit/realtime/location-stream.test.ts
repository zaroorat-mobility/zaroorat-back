import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LocationService } from '../../../src/modules/drivers/services/location/location.service.js';
import { LocationStreamService } from '../../../src/modules/realtime/location-stream.service.js';
import { realtimeConfig } from '../../../src/config/realtime/realtime.config.js';
import type { SocketPrincipal } from '../../../src/modules/realtime/socket-auth.service.js';

const DRIVER: SocketPrincipal = {
  userId: 'user_drv',
  sid: 's',
  epoch: 1,
  roles: ['driver'],
  driverId: 'drv_1',
};
const CUSTOMER: SocketPrincipal = {
  userId: 'user_c',
  sid: 's',
  epoch: 1,
  roles: ['customer'],
  driverId: null,
};
const FRAME = { latitude: 12.9716, longitude: 77.5946 };

function makeService() {
  const writes: Record<string, unknown>[] = [];
  const service = new LocationStreamService(
    {
      async updateLocation(input: Record<string, unknown>) {
        writes.push(input);
        return input;
      },
      async verifyUnstoredFix() {
        return { mustStore: false };
      },
    } as never,
    { findActiveByDriver: async () => null } as never,
    { recordPoint: async () => false } as never,
    { refreshEta: async () => null, forget: () => {} } as never,
  );
  return { service, writes };
}

describe('Driver location streaming', () => {
  describe('who may publish', () => {
    it('refuses a customer', async () => {
      const { service, writes } = makeService();
      await assert.rejects(
        () => service.accept(CUSTOMER, FRAME),
        (err: unknown) => (err as { code?: string }).code === 'SOCKET_FORBIDDEN',
      );
      assert.deepEqual(writes, [], 'nothing may be written for an unauthorised publisher');
    });

    it('refuses a driver with no operable identity', async () => {
      const { service } = makeService();
      await assert.rejects(
        () => service.accept({ ...DRIVER, driverId: null }, FRAME),
        (err: unknown) => (err as { code?: string }).code === 'SOCKET_FORBIDDEN',
      );
    });

    it('accepts an operable driver', async () => {
      const { service, writes } = makeService();
      const accepted = await service.accept(DRIVER, FRAME);
      assert.equal(accepted.envelope.type, 'ride.driver.location');
      assert.equal(accepted.envelope.data.driverId, 'drv_1');
      assert.equal(accepted.persisted, true, 'the first frame is always written through');
      assert.equal(writes.length, 1);
    });
  });

  describe('payload validation', () => {
    const malformed: [string, unknown][] = [
      ['a latitude out of range', { latitude: 999, longitude: 77 }],
      ['a longitude out of range', { latitude: 12, longitude: 999 }],
      ['a missing coordinate', { latitude: 12 }],
      ['a string coordinate', { latitude: '12', longitude: '77' }],
      ['a negative speed', { ...FRAME, speedKmh: -5 }],
      ['a heading beyond a circle', { ...FRAME, heading: 400 }],
      ['null', null],
      ['a bare string', 'nonsense'],
      ['an array', [1, 2]],
    ];

    for (const [label, payload] of malformed) {
      it(`rejects ${label} safely`, async () => {
        const { service, writes } = makeService();
        await assert.rejects(
          () => service.accept(DRIVER, payload),
          (err: unknown) => (err as { code?: string }).code === 'INVALID_SOCKET_PAYLOAD',
        );
        assert.deepEqual(writes, []);
      });
    }

    it('ignores a rideId the client tries to attach', async () => {
      // Which ride a frame belongs to is decided by room membership, never by
      // the payload — the schema strips it.
      const { service } = makeService();
      const accepted = await service.accept(DRIVER, { ...FRAME, rideId: 'ride_someone_else' });
      assert.equal(accepted.envelope.data.rideId, undefined);
    });
  });

  describe('backpressure', () => {
    it('drops a frame arriving inside the minimum interval', async () => {
      const { service } = makeService();
      const now = Date.now();
      await service.accept(DRIVER, FRAME, now);
      await assert.rejects(
        () => service.accept(DRIVER, FRAME, now + realtimeConfig.locationMinIntervalMs - 1),
        (err: unknown) => (err as { code?: string }).code === 'LOCATION_RATE_LIMITED',
      );
    });

    it('accepts again once the interval has passed', async () => {
      const { service } = makeService();
      const now = Date.now();
      await service.accept(DRIVER, FRAME, now);
      const later = await service.accept(DRIVER, FRAME, now + realtimeConfig.locationMinIntervalMs);
      assert.ok(later.envelope);
    });

    it('rate-limits per driver, not globally', async () => {
      const { service } = makeService();
      const now = Date.now();
      await service.accept(DRIVER, FRAME, now);
      const other = await service.accept({ ...DRIVER, driverId: 'drv_2' }, FRAME, now);
      assert.ok(other.envelope, 'one busy driver must not throttle another');
    });
  });

  describe('staleness and ordering', () => {
    it('refuses a frame older than the maximum age', async () => {
      const { service } = makeService();
      const now = Date.now();
      const recordedAt = new Date(now - realtimeConfig.locationMaxAgeMs - 1).toISOString();
      await assert.rejects(
        () => service.accept(DRIVER, { ...FRAME, recordedAt }, now),
        (err: unknown) => (err as { code?: string }).code === 'STALE_LOCATION',
      );
    });

    it('refuses a frame from the future', async () => {
      const { service } = makeService();
      const now = Date.now();
      const recordedAt = new Date(now + realtimeConfig.locationMaxAgeMs + 5_000).toISOString();
      await assert.rejects(
        () => service.accept(DRIVER, { ...FRAME, recordedAt }, now),
        (err: unknown) => (err as { code?: string }).code === 'STALE_LOCATION',
      );
    });

    it('refuses an out-of-order frame replayed after a newer one', async () => {
      const { service } = makeService();
      const now = Date.now();
      await service.accept(DRIVER, { ...FRAME, recordedAt: new Date(now).toISOString() }, now);
      const older = new Date(now - 5_000).toISOString();
      await assert.rejects(
        () =>
          service.accept(
            DRIVER,
            { ...FRAME, recordedAt: older },
            now + realtimeConfig.locationMinIntervalMs,
          ),
        (err: unknown) => (err as { code?: string }).code === 'STALE_LOCATION',
      );
    });

    it('refuses an unparseable timestamp', async () => {
      const { service } = makeService();
      await assert.rejects(
        () => service.accept(DRIVER, { ...FRAME, recordedAt: 'not-a-date' }),
        (err: unknown) => (err as { code?: string }).code === 'INVALID_SOCKET_PAYLOAD',
      );
    });
  });

  describe('storage sampling', () => {
    it('broadcasts every accepted frame but writes only on the sampling interval', async () => {
      const { service, writes } = makeService();
      const start = Date.now();
      let broadcasts = 0;

      // One frame per minimum interval, across two sampling windows.
      const step = realtimeConfig.locationMinIntervalMs;
      const span = realtimeConfig.locationPersistIntervalMs * 2;
      for (let elapsed = 0; elapsed <= span; elapsed += step) {
        const accepted = await service.accept(DRIVER, FRAME, start + elapsed);
        if (accepted.envelope) broadcasts++;
      }

      assert.ok(broadcasts > writes.length, 'far more frames broadcast than written');
      const expectedWrites = Math.floor(span / realtimeConfig.locationPersistIntervalMs) + 1;
      assert.equal(writes.length, expectedWrites, 'exactly one write per sampling window');
    });

    it('forgets a driver on disconnect so state cannot grow without bound', async () => {
      const { service } = makeService();
      const now = Date.now();
      await service.accept(DRIVER, FRAME, now);
      service.forget('drv_1');
      // A fresh frame at the same instant is accepted again — the throttle state
      // really was dropped.
      const again = await service.accept(DRIVER, FRAME, now);
      assert.equal(again.persisted, true);
    });
  });

  // The real LocationService and plausibility rules, with only the stores faked.
  describe('integrity of frames between writes', () => {
    // The two emulators behind the reported incident: 2362.68 km apart.
    const BENGALURU = { latitude: 12.971998, longitude: 77.594998, accuracyMeters: 5 };
    const SRINAGAR = { latitude: 34.06, longitude: 74.73, accuracyMeters: 5 };
    const ACTIVE_RIDE = {
      id: 'ride_1',
      status: 'IN_PROGRESS',
      request: {
        pickupLat: 12.97,
        pickupLng: 77.59,
        dropLat: SRINAGAR.latitude,
        dropLng: SRINAGAR.longitude,
      },
    };

    /// One shared `driver_locations` row, serialised as the advisory lock does.
    function makeStore() {
      const store = {
        row: null as null | { latitude: number; longitude: number; recordedAt: Date },
        writes: 0,
        queue: Promise.resolve() as Promise<unknown>,
        withDriverLock<T>(_driverId: string, fn: (tx: never) => Promise<T>): Promise<T> {
          const run = store.queue.then(() => fn({} as never));
          store.queue = run.catch(() => undefined);
          return run;
        },
        async getLocation() {
          return store.row ? { ...store.row } : null;
        },
        async updateLocation(
          input: { latitude: number; longitude: number },
          _tx: unknown,
          recordedAt: Date,
        ) {
          store.writes += 1;
          store.row = { latitude: input.latitude, longitude: input.longitude, recordedAt };
          return { ...store.row };
        },
        clear() {
          store.row = null;
        },
        age(seconds: number) {
          assert.ok(store.row, 'there must be a stored fix to age');
          store.row.recordedAt = new Date(Date.now() - seconds * 1000);
        },
      };
      return store;
    }

    /// One API replica: its own stream state, the shared store.
    function makeReplica(store: ReturnType<typeof makeStore>) {
      const seen = {
        history: [] as { latitude: number }[],
        eta: [] as { driverPosition: { latitude: number } }[],
        arrival: [] as { latitude: number }[],
        geo: [] as unknown[],
        tripKm: [] as number[],
        rejected: [] as { reason: unknown }[],
        resets: 0,
      };
      const arrival = {
        evaluateFix: async (fix: { latitude: number }) => {
          seen.arrival.push(fix);
          return { evaluated: true };
        },
      };
      const locationService = new LocationService(
        store as never,
        {
          findById: async () => ({
            id: 'drv_1',
            verificationStatus: 'VERIFIED',
            isSuspended: false,
            isAvailable: true,
          }),
        } as never,
        { updateHeartbeat: async () => undefined } as never,
        {
          mockLocationRejected: () => {},
          implausibleLocationRejected: (fields: { reason: unknown }) => seen.rejected.push(fields),
          staleLocationBaselineReset: () => void seen.resets++,
          locationUpdated: () => {},
        } as never,
        {
          recordDriverPosition: async (position: unknown) => void seen.geo.push(position),
        } as never,
        {
          tripDistance: { add: async (_id: string, km: number) => void seen.tripKm.push(km) },
        } as never,
        { findActiveByDriver: async () => null } as never,
        {} as never,
        arrival as never,
      );
      const stream = new LocationStreamService(
        locationService,
        { findActiveByDriver: async () => ACTIVE_RIDE } as never,
        {
          recordPoint: async (point: { latitude: number }) => {
            seen.history.push(point);
            return true;
          },
        } as never,
        {
          refreshEta: async (input: { driverPosition: { latitude: number } }) => {
            seen.eta.push(input);
            return null;
          },
        } as never,
        arrival as never,
      );
      return { stream, seen };
    }

    function downstream(seen: ReturnType<typeof makeReplica>['seen']) {
      return { history: seen.history.length, eta: seen.eta.length, arrival: seen.arrival.length };
    }

    const isImplausible = (reason: string, detail?: RegExp) => (err: unknown) => {
      const e = err as { code?: string; reason?: string; message?: string };
      assert.equal(e.code, 'IMPLAUSIBLE_LOCATION');
      assert.equal(e.reason, reason);
      if (detail) assert.match(e.message ?? '', detail);
      return true;
    };

    /// A replica that has just written Bengaluru, so its next frames are not due a write.
    async function afterAWrite() {
      const store = makeStore();
      const replica = makeReplica(store);
      const start = Date.now();
      const first = await replica.stream.accept(DRIVER, BENGALURU, start);
      assert.equal(first.persisted, true);
      return { store, start, ...replica };
    }

    it('forwards normal movement between writes without writing it', async () => {
      const { store, stream, seen, start } = await afterAWrite();
      store.age(4);
      const before = downstream(seen);
      // About 110 m in 4 s: around 100 km/h.
      const moved = { ...BENGALURU, latitude: BENGALURU.latitude + 0.001 };

      const accepted = await stream.accept(DRIVER, moved, start + 4_000);

      assert.equal(accepted.persisted, false);
      assert.equal(accepted.envelope.data.latitude, moved.latitude);
      assert.equal(store.writes, 1);
      assert.equal(store.row?.latitude, BENGALURU.latitude, 'the stored baseline did not move');
      assert.deepEqual(downstream(seen), {
        history: before.history,
        eta: before.eta + 1,
        arrival: before.arrival + 1,
      });
    });

    it('refuses the 2,362.68 km frame 2 s after a write, before anything downstream', async () => {
      const { store, stream, seen, start } = await afterAWrite();
      store.age(2);
      const before = downstream(seen);

      await assert.rejects(
        () => stream.accept(DRIVER, SRINAGAR, start + 2_000),
        isImplausible('impossible_speed', /2362\.68km/),
      );

      assert.deepEqual(downstream(seen), before, 'no history, ETA or arrival evaluation');
      assert.equal(store.writes, 1);
      assert.equal(store.row?.latitude, BENGALURU.latitude);
      assert.deepEqual(
        seen.rejected.map((fields) => fields.reason),
        ['impossible_speed'],
        'counted like any other refused fix',
      );
    });

    it('keeps accepting honest frames after refusing one', async () => {
      const { store, stream, start } = await afterAWrite();
      store.age(2);
      await assert.rejects(() => stream.accept(DRIVER, SRINAGAR, start + 2_000));

      const next = await stream.accept(DRIVER, BENGALURU, start + 3_000);

      assert.equal(next.envelope.data.latitude, BENGALURU.latitude);
    });

    it('refuses a mock location between writes, as it does on a write', async () => {
      const { stream, seen, start } = await afterAWrite();
      const before = downstream(seen);

      await assert.rejects(
        () => stream.accept(DRIVER, { ...BENGALURU, isMockLocation: true }, start + 2_000),
        (err: unknown) => (err as { code?: string }).code === 'MOCK_LOCATION_REJECTED',
      );

      assert.deepEqual(downstream(seen), before);
    });

    it('refuses the (0, 0) null fix between writes', async () => {
      const { stream, seen, start } = await afterAWrite();
      const before = downstream(seen);

      await assert.rejects(
        () => stream.accept(DRIVER, { latitude: 0, longitude: 0 }, start + 2_000),
        isImplausible('out_of_range'),
      );

      assert.deepEqual(downstream(seen), before);
    });

    it('refuses the 244.1 s incident jump on the write path', async () => {
      const store = makeStore();
      store.row = {
        latitude: BENGALURU.latitude,
        longitude: BENGALURU.longitude,
        recordedAt: new Date(Date.now() - 244_100),
      };
      const { stream, seen } = makeReplica(store);

      await assert.rejects(
        () => stream.accept(DRIVER, SRINAGAR),
        isImplausible('impossible_speed', /2362\.68km in 244\.1s/),
      );

      assert.deepEqual(downstream(seen), { history: 0, eta: 0, arrival: 0 });
      assert.equal(store.writes, 0);
    });

    it('still refuses the jump between writes just inside the stale window', async () => {
      const { store, stream, start } = await afterAWrite();
      store.age(299);

      await assert.rejects(
        () => stream.accept(DRIVER, SRINAGAR, start + 2_000),
        isImplausible('impossible_speed'),
      );
      assert.equal(store.row?.latitude, BENGALURU.latitude);
    });

    it('sends a frame that must replace a stale baseline through the locked write', async () => {
      const { store, stream, seen, start } = await afterAWrite();
      store.age(301);

      const accepted = await stream.accept(DRIVER, SRINAGAR, start + 2_000);

      assert.equal(accepted.persisted, true, 'an unlocked read must never move the baseline');
      assert.equal(store.writes, 2);
      assert.equal(store.row?.latitude, SRINAGAR.latitude);
      assert.equal(seen.resets, 1);
      assert.deepEqual(seen.tripKm, [], 'a reset is not distance driven');
    });

    it('stores a frame when no baseline exists, even inside the window', async () => {
      const { store, stream, start } = await afterAWrite();
      store.clear();

      const accepted = await stream.accept(DRIVER, BENGALURU, start + 2_000);

      assert.equal(accepted.persisted, true);
      assert.equal(store.row?.latitude, BENGALURU.latitude);
    });

    it('judges a frame by the baseline another replica wrote, not its own memory', async () => {
      const store = makeStore();
      const replicaA = makeReplica(store);
      const replicaB = makeReplica(store);
      const start = Date.now();
      // Replica B last wrote Bengaluru, so its next frames are not due a write.
      await replicaB.stream.accept(DRIVER, BENGALURU, start);
      // Replica A moves the shared baseline to Srinagar through a stale reset.
      store.age(301);
      await replicaA.stream.accept(DRIVER, SRINAGAR, start);
      assert.equal(store.row?.latitude, SRINAGAR.latitude);
      store.age(2);

      // What replica B remembers is now the impossible position...
      await assert.rejects(
        () => replicaB.stream.accept(DRIVER, BENGALURU, start + 2_000),
        isImplausible('impossible_speed'),
      );
      // ...and the shared baseline is the plausible one.
      const nearby = { ...SRINAGAR, latitude: SRINAGAR.latitude + 0.0001 };
      const accepted = await replicaB.stream.accept(DRIVER, nearby, start + 3_000);
      assert.equal(accepted.persisted, false);
      assert.equal(accepted.envelope.data.latitude, nearby.latitude);
    });

    it('checks the first frame after a reconnect against the stored baseline', async () => {
      const { store, stream, seen, start } = await afterAWrite();
      stream.forget('drv_1');
      store.age(2);
      const before = downstream(seen);

      await assert.rejects(
        () => stream.accept(DRIVER, SRINAGAR, start + 2_000),
        isImplausible('impossible_speed'),
      );

      assert.deepEqual(downstream(seen), before);
      assert.equal(store.writes, 1);
    });

    it('lets only the honest frame through when frames race between writes', async () => {
      const { store, stream, seen, start } = await afterAWrite();
      store.age(2);
      const before = downstream(seen);

      const [impossible, honest] = await Promise.allSettled([
        stream.accept(DRIVER, SRINAGAR, start + 2_000),
        stream.accept(DRIVER, BENGALURU, start + 2_000),
      ]);

      assert.equal(impossible.status, 'rejected');
      assert.equal(honest.status, 'fulfilled');
      assert.deepEqual(downstream(seen), {
        history: before.history,
        eta: before.eta + 1,
        arrival: before.arrival + 1,
      });
      assert.equal(seen.eta.at(-1)?.driverPosition.latitude, BENGALURU.latitude);
    });

    it('lets one racing frame replace a stale baseline and checks the other against it', async () => {
      const { store, stream, seen, start } = await afterAWrite();
      store.age(301);

      const results = await Promise.allSettled([
        stream.accept(DRIVER, SRINAGAR, start + 2_000),
        stream.accept(DRIVER, { ...BENGALURU, latitude: 20, longitude: 75 }, start + 2_000),
      ]);

      assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
      assert.equal(seen.resets, 1);
      assert.equal(store.writes, 2);
      assert.deepEqual(seen.tripKm, []);
    });

    it('adds only real movement to the trip meter, never a refused frame', async () => {
      const { store, stream, seen, start } = await afterAWrite();
      store.age(2);
      await assert.rejects(() => stream.accept(DRIVER, SRINAGAR, start + 2_000));
      await assert.rejects(() => stream.accept(DRIVER, SRINAGAR, start + 3_000));
      assert.deepEqual(seen.tripKm, []);

      store.age(20);
      const moved = { ...BENGALURU, latitude: BENGALURU.latitude + 0.002 };
      const written = await stream.accept(DRIVER, moved, start + 6_000);

      assert.equal(written.persisted, true);
      assert.equal(seen.tripKm.length, 1);
      assert.ok(seen.tripKm[0]! > 0.2 && seen.tripKm[0]! < 0.25, `got ${seen.tripKm[0]} km`);
    });
  });
});

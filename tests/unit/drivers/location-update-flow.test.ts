import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LocationService } from '../../../src/modules/drivers/services/location/location.service.js';
import {
  DriverNotFoundError,
  ImplausibleLocationError,
} from '../../../src/modules/drivers/errors/driver.errors.js';
import type { UpdateDriverLocationInput } from '../../../src/modules/drivers/repositories/driver-location.repository.js';

const DRIVER_ID = 'driver-1';
const PUNE = { latitude: 18.5308, longitude: 73.8475 };
const EMULATOR_DEFAULT = { latitude: 37.4219983, longitude: -122.084 };
const SRINAGAR = { latitude: 34.0837, longitude: 74.7973 };

type StoredRow = { driverId: string; latitude: number; longitude: number; recordedAt: Date };

/// In-memory stand-in for DriverLocationRepository. `withDriverLock` runs
/// callers one at a time, as the per-driver advisory lock does in Postgres;
/// `updateLocation` keeps the "never replace a newer row" rule.
class FakeLocationRepo {
  row: StoredRow | null = null;
  writes = 0;
  failWith: Error | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  async withDriverLock<T>(_driverId: string, fn: (tx: never) => Promise<T>): Promise<T> {
    if (this.failWith) throw this.failWith;
    const run = this.queue.then(() => fn({} as never));
    this.queue = run.catch(() => undefined);
    return run;
  }
  async getLocation(): Promise<StoredRow | null> {
    return this.row ? { ...this.row } : null;
  }
  async updateLocation(input: UpdateDriverLocationInput, _tx: unknown, recordedAt = new Date()) {
    this.writes += 1;
    if (!this.row || this.row.recordedAt <= recordedAt) {
      this.row = {
        driverId: input.driverId,
        latitude: input.latitude,
        longitude: input.longitude,
        recordedAt,
      };
    }
    return { ...this.row };
  }
}

function harness(
  options: {
    previous?: { latitude: number; longitude: number; secondsAgo: number };
    driver?: Record<string, unknown> | null;
  } = {},
) {
  const repo = new FakeLocationRepo();
  if (options.previous) {
    repo.row = {
      driverId: DRIVER_ID,
      latitude: options.previous.latitude,
      longitude: options.previous.longitude,
      recordedAt: new Date(Date.now() - options.previous.secondsAgo * 1000),
    };
  }
  const calls = {
    geo: [] as unknown[],
    heartbeat: 0,
    tripKm: [] as number[],
    rejected: [] as unknown[],
    resets: 0,
    updated: 0,
  };
  const driver =
    options.driver === undefined
      ? { id: DRIVER_ID, verificationStatus: 'VERIFIED', isSuspended: false, isAvailable: true }
      : options.driver;
  const service = new LocationService(
    repo as never,
    { findById: async () => driver } as never,
    { updateHeartbeat: async () => void calls.heartbeat++ } as never,
    {
      mockLocationRejected: () => {},
      implausibleLocationRejected: (fields: unknown) => void calls.rejected.push(fields),
      staleLocationBaselineReset: () => void calls.resets++,
      locationUpdated: () => void calls.updated++,
    } as never,
    { recordDriverPosition: async (p: unknown) => void calls.geo.push(p) } as never,
    {
      tripDistance: { add: async (_id: string, km: number) => void calls.tripKm.push(km) },
    } as never,
    { findActiveByDriver: async () => null } as never,
    {} as never,
  );
  const update = (point: { latitude: number; longitude: number }, extra = {}) =>
    service.updateLocation({ driverId: DRIVER_ID, ...point, ...extra });
  return { repo, calls, update };
}

describe('LocationService.updateLocation — stale baseline, concurrency and failures', () => {
  it('replaces a stale far-away baseline, persists the fix and reports a reset', async () => {
    const { repo, calls, update } = harness({ previous: { ...PUNE, secondsAgo: 45_000 } });

    await update(EMULATOR_DEFAULT, { accuracyMeters: 5 });

    assert.equal(repo.row?.latitude, EMULATOR_DEFAULT.latitude);
    assert.equal(calls.resets, 1);
    assert.equal(calls.rejected.length, 0);
    assert.equal(calls.geo.length, 1, 'eligible driver is published to the live index');
    assert.equal(calls.heartbeat, 1);
  });

  it('never accrues trip-meter distance across a reset, but does for real movement', async () => {
    const reset = harness({ previous: { ...PUNE, secondsAgo: 45_000 } });
    await reset.update(EMULATOR_DEFAULT, { accuracyMeters: 5 });
    assert.deepEqual(reset.calls.tripKm, [], 'a 13,573km re-baseline must not reach a fare');

    const moving = harness({ previous: { ...PUNE, secondsAgo: 30 } });
    await moving.update({ latitude: PUNE.latitude + 0.002, longitude: PUNE.longitude });
    assert.equal(moving.calls.tripKm.length, 1);
    assert.ok(moving.calls.tripKm[0]! > 0.2 && moving.calls.tripKm[0]! < 0.25);
  });

  it('keeps accepting updates after a reset, with the speed check active again', async () => {
    const { repo, update } = harness({ previous: { ...PUNE, secondsAgo: 45_000 } });
    await update(EMULATOR_DEFAULT, { accuracyMeters: 5 });

    // ~20m away moments later: inside the noise floor, accepted.
    await update({
      latitude: EMULATOR_DEFAULT.latitude + 0.0002,
      longitude: EMULATOR_DEFAULT.longitude,
    });
    assert.equal(repo.row?.latitude, EMULATOR_DEFAULT.latitude + 0.0002);

    // 5km away moments later: an impossible jump from the new, fresh baseline.
    await assert.rejects(
      update({
        latitude: EMULATOR_DEFAULT.latitude + 0.045,
        longitude: EMULATOR_DEFAULT.longitude,
      }),
      ImplausibleLocationError,
    );
    assert.equal(repo.row?.latitude, EMULATOR_DEFAULT.latitude + 0.0002);
  });

  it('rejects a recent impossible jump without writing or publishing anything', async () => {
    const { repo, calls, update } = harness({ previous: { ...PUNE, secondsAgo: 30 } });

    await assert.rejects(update(EMULATOR_DEFAULT), (err: unknown) => {
      assert.ok(err instanceof ImplausibleLocationError);
      assert.equal(err.reason, 'impossible_speed');
      return true;
    });
    assert.equal(repo.writes, 0);
    assert.equal(repo.row?.latitude, PUNE.latitude);
    assert.equal(calls.geo.length, 0);
    assert.equal(calls.heartbeat, 0);
    assert.deepEqual(calls.rejected, [{ driverId: DRIVER_ID, reason: 'impossible_speed' }]);
  });

  it('refuses a poor-accuracy fix that would replace a stale location', async () => {
    const { repo, update } = harness({ previous: { ...PUNE, secondsAgo: 45_000 } });

    await assert.rejects(update(EMULATOR_DEFAULT, { accuracyMeters: 2_000 }), (err: unknown) => {
      assert.ok(err instanceof ImplausibleLocationError);
      assert.equal(err.reason, 'poor_accuracy');
      return true;
    });
    assert.equal(repo.writes, 0);
  });

  it('serialises concurrent fixes so both cannot pass against the same stale point', async () => {
    const { repo, update } = harness({ previous: { ...PUNE, secondsAgo: 45_000 } });

    const results = await Promise.allSettled([
      update(EMULATOR_DEFAULT, { accuracyMeters: 5 }),
      update(SRINAGAR, { accuracyMeters: 5 }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'the first fix re-baselines');
    assert.equal(rejected.length, 1, 'the second is checked against that new baseline');
    assert.ok((rejected[0] as PromiseRejectedResult).reason instanceof ImplausibleLocationError);
    assert.equal(repo.row?.latitude, EMULATOR_DEFAULT.latitude);
  });

  it('surfaces a database failure and performs no side effects', async () => {
    const { repo, calls, update } = harness({ previous: { ...PUNE, secondsAgo: 30 } });
    repo.failWith = new Error('connection terminated unexpectedly');

    await assert.rejects(update(PUNE), /connection terminated unexpectedly/);
    assert.equal(calls.geo.length, 0);
    assert.equal(calls.heartbeat, 0);
    assert.equal(calls.updated, 0);
  });

  it('persists but never publishes an ineligible driver to dispatch, even on a reset', async () => {
    for (const driver of [
      { id: DRIVER_ID, verificationStatus: 'PENDING', isSuspended: false, isAvailable: true },
      { id: DRIVER_ID, verificationStatus: 'VERIFIED', isSuspended: true, isAvailable: true },
      { id: DRIVER_ID, verificationStatus: 'VERIFIED', isSuspended: false, isAvailable: false },
    ]) {
      const { repo, calls, update } = harness({
        previous: { ...PUNE, secondsAgo: 45_000 },
        driver,
      });
      await update(EMULATOR_DEFAULT, { accuracyMeters: 5 });
      assert.equal(repo.row?.latitude, EMULATOR_DEFAULT.latitude);
      assert.equal(calls.geo.length, 0, `not published: ${JSON.stringify(driver)}`);
    }
  });

  it('refuses a location for a driver that does not exist', async () => {
    const { repo, update } = harness({ driver: null });
    await assert.rejects(update(PUNE), DriverNotFoundError);
    assert.equal(repo.writes, 0);
  });

  it('returns the newer stored fix without side effects when the write is superseded', async () => {
    // A stored fix stamped 10s ahead (another instance with a faster clock):
    // the upsert keeps it, so this fix was never stored and must not act as stored.
    const { repo, calls, update } = harness({ previous: { ...PUNE, secondsAgo: -10 } });
    const storedAt = repo.row!.recordedAt;

    const result = await update({ latitude: PUNE.latitude + 0.0001, longitude: PUNE.longitude });

    assert.equal(result.latitude, PUNE.latitude, 'the stored (newer) row is returned');
    assert.equal(repo.row?.recordedAt, storedAt);
    assert.equal(calls.geo.length, 0);
    assert.equal(calls.heartbeat, 0);
    assert.deepEqual(calls.tripKm, []);
    assert.equal(calls.updated, 0);
  });
});

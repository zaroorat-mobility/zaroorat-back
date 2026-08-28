import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LocationService } from '../../../src/modules/drivers/services/location/location.service.js';
import { rideConfig } from '../../../src/config/ride/ride.config.js';

const BLR = { latitude: 12.9716, longitude: 77.5946 };

/// One degree of latitude is about 111km, which is all the arithmetic needed to
/// put a fix a chosen distance due north of another.
function metresNorth(metres: number) {
  return { latitude: BLR.latitude + metres / 111_000, longitude: BLR.longitude };
}

function makeWorld(previous: { latitude: number; longitude: number } | null = BLR) {
  const meter = new Map<string, number>();
  const stored = { ...BLR };

  const locationRepo = {
    async getLocation() {
      return previous === null ? null : { ...previous, recordedAt: new Date(Date.now() - 30_000) };
    },
    async updateLocation(input: { latitude: number; longitude: number }) {
      stored.latitude = input.latitude;
      stored.longitude = input.longitude;
      return { ...input, recordedAt: new Date() };
    },
  };

  const service = new LocationService(
    locationRepo as never,
    {
      async findById(id: string) {
        return { id, verificationStatus: 'VERIFIED', isSuspended: false, isAvailable: false };
      },
    } as never,
    { async updateHeartbeat() {} } as never,
    { locationUpdated() {}, mockLocationRejected() {}, implausibleLocationRejected() {} } as never,
    { async recordDriverPosition() {} } as never,
    {
      tripDistance: {
        async add(driverId: string, km: number) {
          meter.set(driverId, (meter.get(driverId) ?? 0) + km);
        },
        async read(driverId: string) {
          return meter.get(driverId) ?? 0;
        },
        async reset(driverId: string) {
          meter.delete(driverId);
        },
      },
    } as never,
  );

  return { service, meter };
}

/// The server measuring the journey itself is what stops a ride's fare being
/// whatever number the driver's app puts in the completion request (C-3b). It
/// is built from the location fixes the app already sends.
describe('the trip distance meter (C-3b)', () => {
  async function post(
    world: ReturnType<typeof makeWorld>,
    to: { latitude: number; longitude: number },
    accuracyMeters?: number,
  ) {
    await world.service.updateLocation({
      driverId: 'drv_1',
      ...to,
      ...(accuracyMeters !== undefined ? { accuracyMeters } : {}),
    });
  }

  it('adds the distance covered since the last fix', async () => {
    const world = makeWorld();
    await post(world, metresNorth(1000));

    const km = world.meter.get('drv_1') ?? 0;
    assert.ok(Math.abs(km - 1) < 0.05, `expected about 1km, got ${km}`);
  });

  it('ignores jitter below the noise floor', async () => {
    const world = makeWorld();
    // A parked car with a wandering fix must not earn kilometres.
    await post(world, metresNorth(rideConfig.distanceNoiseFloorMeters - 5));

    assert.equal(world.meter.get('drv_1'), undefined, 'standing still is not travel');
  });

  it('counts a hop above the noise floor', async () => {
    const world = makeWorld();
    await post(world, metresNorth(rideConfig.distanceNoiseFloorMeters + 30));

    assert.ok((world.meter.get('drv_1') ?? 0) > 0);
  });

  it('ignores a fix that does not know where it is', async () => {
    const world = makeWorld();
    await post(world, metresNorth(1000), rideConfig.distanceMaxAccuracyMeters + 1);

    assert.equal(world.meter.get('drv_1'), undefined);
  });

  it('trusts a fix reporting accuracy within the limit', async () => {
    const world = makeWorld();
    await post(world, metresNorth(1000), rideConfig.distanceMaxAccuracyMeters);

    assert.ok((world.meter.get('drv_1') ?? 0) > 0);
  });

  it('has nothing to measure from on a driver’s first fix', async () => {
    const world = makeWorld(null);
    await post(world, metresNorth(1000));

    assert.equal(world.meter.get('drv_1'), undefined);
  });
});

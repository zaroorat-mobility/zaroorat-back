import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { bootApp, db, loginAs, resetState, type LoggedInUser } from './helpers/harness.js';
import {
  grantRole,
  makeAssignedVehicle,
  makeDispatchOffer,
  makeDriver,
  makeRideRequest,
} from './helpers/fixtures.js';
import { container } from '../../src/core/di.js';
import type { DriverLocationRepository } from '../../src/modules/drivers/repositories/driver-location.repository.js';
import type { GeoService } from '../../src/modules/location/core-services/geo.service.js';
import type { NearbyDriversResult } from '../../src/modules/location/types/geo.types.js';

const PUNE = { latitude: 18.5308, longitude: 73.8475 };
// Android emulator's default fix after a cold boot (Google HQ, Mountain View).
const EMULATOR_DEFAULT = { latitude: 37.4219983, longitude: -122.084, accuracyMeters: 5 };
const SRINAGAR = { latitude: 34.0837, longitude: 74.7973, accuracyMeters: 5 };
const TWELVE_AND_A_HALF_HOURS = 45_000;

type Driver = LoggedInUser & { driverId: string };

function driverIdsOf(result: NearbyDriversResult): string[] {
  return result.outcome === 'no-live-candidates' ? [] : result.drivers.map((d) => d.driverId);
}

describe('driver location plausibility — stale baseline (integration)', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await bootApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(async () => {
    await resetState();
  });

  async function driverUser(phone: string): Promise<Driver> {
    const seed = await loginAs(app, phone);
    await grantRole(seed.userId, 'driver');
    const user = await loginAs(app, phone);
    const driverId = await makeDriver(user.userId, { verified: true });
    return { ...user, driverId };
  }

  async function onlineDriver(phone: string): Promise<Driver & { vehicleTypeId: string }> {
    const driver = await driverUser(phone);
    const { vehicleTypeId } = await makeAssignedVehicle(driver.driverId);
    const online = await app.inject({
      method: 'POST',
      url: '/api/v1/drivers/status/online',
      headers: driver.authHeader,
      payload: {},
    });
    assert.equal(online.statusCode, 200, online.payload);
    return { ...driver, vehicleTypeId };
  }

  function postLocation(user: LoggedInUser | null, body: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/drivers/location',
      ...(user ? { headers: user.authHeader } : {}),
      payload: body,
    });
  }

  /// Back-dates the stored fix, standing in for a device that went quiet.
  async function ageLastFix(driverId: string, seconds: number): Promise<void> {
    await db().client.driverLocation.update({
      where: { driverId },
      data: { recordedAt: new Date(Date.now() - seconds * 1000) },
    });
  }

  function stored(driverId: string) {
    return db().client.driverLocation.findUniqueOrThrow({ where: { driverId } });
  }

  it('accepts a new position once the last fix is stale, then keeps accepting updates', async () => {
    const driver = await driverUser('+919876741001');
    assert.equal((await postLocation(driver, PUNE)).statusCode, 200);
    await ageLastFix(driver.driverId, TWELVE_AND_A_HALF_HOURS);

    const reset = await postLocation(driver, EMULATOR_DEFAULT);
    assert.equal(reset.statusCode, 200, reset.payload);
    const afterReset = await stored(driver.driverId);
    assert.equal(Number(afterReset.latitude), EMULATOR_DEFAULT.latitude);
    assert.ok(Date.now() - afterReset.recordedAt.getTime() < 60_000, 'stamped with server now');

    // The next fixes are no longer measured against Pune — no indefinite lock-out.
    for (const step of [1, 2, 3]) {
      const nearby = await postLocation(driver, {
        ...EMULATOR_DEFAULT,
        latitude: EMULATOR_DEFAULT.latitude + step * 0.0001,
      });
      assert.equal(nearby.statusCode, 200, nearby.payload);
    }
  });

  it('still rejects a recent impossible jump and keeps the last valid fix', async () => {
    const driver = await driverUser('+919876741002');
    assert.equal((await postLocation(driver, PUNE)).statusCode, 200);

    const jump = await postLocation(driver, EMULATOR_DEFAULT);
    assert.equal(jump.statusCode, 400, jump.payload);
    assert.equal(jump.json().error.code, 'IMPLAUSIBLE_LOCATION');
    assert.equal(Number((await stored(driver.driverId)).latitude), PUNE.latitude);
  });

  it('serialises concurrent updates so only one of them can replace a stale fix', async () => {
    const driver = await driverUser('+919876741003');
    assert.equal((await postLocation(driver, PUNE)).statusCode, 200);
    await ageLastFix(driver.driverId, TWELVE_AND_A_HALF_HOURS);

    const [a, b] = await Promise.all([
      postLocation(driver, EMULATOR_DEFAULT),
      postLocation(driver, SRINAGAR),
    ]);
    const statuses = [a.statusCode, b.statusCode].sort();
    assert.deepEqual(statuses, [200, 400], `${a.payload} | ${b.payload}`);

    // Whichever won the lock is what is stored; the loser was checked against it.
    const winner = a.statusCode === 200 ? EMULATOR_DEFAULT : SRINAGAR;
    assert.equal(Number((await stored(driver.driverId)).latitude), winner.latitude);
  });

  it('serialises concurrent first-ever updates — there is no row yet to lock', async () => {
    const driver = await driverUser('+919876741009');

    const [a, b] = await Promise.all([
      postLocation(driver, EMULATOR_DEFAULT),
      postLocation(driver, SRINAGAR),
    ]);
    const statuses = [a.statusCode, b.statusCode].sort();
    assert.deepEqual(statuses, [200, 400], `${a.payload} | ${b.payload}`);

    const winner = a.statusCode === 200 ? EMULATOR_DEFAULT : SRINAGAR;
    assert.equal(Number((await stored(driver.driverId)).latitude), winner.latitude);
  });

  it('never lets an older fix overwrite a newer stored one', async () => {
    const driver = await driverUser('+919876741010');
    const repo = container.resolve<DriverLocationRepository>('driverLocationRepository');
    const newer = new Date();

    await repo.updateLocation({ driverId: driver.driverId, ...PUNE }, undefined, newer);
    const returned = await repo.updateLocation(
      { driverId: driver.driverId, ...SRINAGAR },
      undefined,
      new Date(newer.getTime() - 60_000),
    );

    const row = await stored(driver.driverId);
    assert.equal(Number(row.latitude), PUNE.latitude, 'the older write was ignored');
    assert.equal(row.recordedAt.getTime(), newer.getTime());
    assert.equal(Number(returned.latitude), PUNE.latitude, 'the stored row is returned');
  });

  it('refuses an unauthenticated location update', async () => {
    const before = await db().client.driverLocation.count();
    const response = await postLocation(null, PUNE);
    assert.equal(response.statusCode, 401, response.payload);
    assert.equal(await db().client.driverLocation.count(), before);
  });

  it('refuses a caller without a driver profile', async () => {
    const customer = await loginAs(app, '+919876741004');
    const before = await db().client.driverLocation.count();
    const response = await postLocation(customer, PUNE);
    assert.equal(response.statusCode, 404, response.payload);
    assert.equal(await db().client.driverLocation.count(), before);
  });

  it('makes an online driver matchable again after a reset; an offline driver stays unmatched', async () => {
    const geo = container.resolve<GeoService>('geoService');
    const online = await onlineDriver('+919876741005');
    assert.equal((await postLocation(online, PUNE)).statusCode, 200);
    await ageLastFix(online.driverId, TWELVE_AND_A_HALF_HOURS);

    const stale = await geo.findNearbyDrivers({ origin: PUNE, radiusMeters: 1000 });
    assert.equal(
      driverIdsOf(stale).includes(online.driverId),
      false,
      'stale fix is not dispatchable',
    );

    assert.equal((await postLocation(online, EMULATOR_DEFAULT)).statusCode, 200);
    const fresh = await geo.findNearbyDrivers({ origin: EMULATOR_DEFAULT, radiusMeters: 1000 });
    assert.ok(driverIdsOf(fresh).includes(online.driverId), 'matchable at the new position');

    // A verified driver who never went online: the fix is stored, not dispatchable.
    const offline = await driverUser('+919876741006');
    await makeAssignedVehicle(offline.driverId);
    assert.equal((await postLocation(offline, EMULATOR_DEFAULT)).statusCode, 200);
    const again = await geo.findNearbyDrivers({ origin: EMULATOR_DEFAULT, radiusMeters: 1000 });
    assert.equal(driverIdsOf(again).includes(offline.driverId), false);
  });

  it('lists pending offers independently of location validation', async () => {
    const driver = await onlineDriver('+919876741007');
    const customer = await loginAs(app, '+919876741008');
    const requestId = await makeRideRequest(customer.userId, driver.vehicleTypeId);
    await makeDispatchOffer(requestId, driver.driverId);

    assert.equal((await postLocation(driver, PUNE)).statusCode, 200);
    assert.equal((await postLocation(driver, EMULATOR_DEFAULT)).statusCode, 400);

    const offers = await app.inject({
      method: 'GET',
      url: '/api/v1/rides/offers',
      headers: driver.authHeader,
    });
    assert.equal(offers.statusCode, 200, offers.payload);
    assert.equal(offers.json().data.length, 1);
  });
});

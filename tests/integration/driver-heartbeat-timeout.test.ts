import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { driverConfig } from '../../src/config/driver/driver.config.js';
import { container } from '../../src/core/di.js';
import type { HeartbeatTimeoutJob } from '../../src/modules/drivers/jobs/heartbeat-timeout.job.js';
import type { GeoService } from '../../src/modules/location/core-services/geo.service.js';
import {
  bootApp,
  db,
  drainOutbox,
  loginAs,
  resetState,
  type LoggedInUser,
} from './helpers/harness.js';
import { grantRole, makeAssignedVehicle, makeDriver } from './helpers/fixtures.js';

const CENTRE = { latitude: 12.9716, longitude: 77.5946 };
const STALE = new Date(Date.now() - (driverConfig.heartbeatTimeoutSeconds + 120) * 1000);

/// The server half of background tracking: a driver whose app keeps sending fixes
/// (the background task) stays online; one that goes silent past the heartbeat
/// timeout is taken offline and out of dispatch by the worker job.
describe('driver heartbeat timeout (integration)', () => {
  let app: FastifyInstance;
  let phone = 0;

  before(async () => {
    app = await bootApp();
  });
  after(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetState();
  });

  const job = () => container.resolve<HeartbeatTimeoutJob>('heartbeatTimeoutJob');
  const geo = () => container.resolve<GeoService>('geoService');

  /// A verified, vehicled driver brought online over HTTP and placed at CENTRE.
  async function onlineDriver(): Promise<LoggedInUser & { driverId: string }> {
    phone += 1;
    const number = `+9198767820${String(phone).padStart(2, '0')}`;
    const seed = await loginAs(app, number);
    await grantRole(seed.userId, 'driver');
    await drainOutbox();
    const user = await loginAs(app, number);
    const driverId = await makeDriver(user.userId, { verified: true });
    await makeAssignedVehicle(driverId);
    const online = await app.inject({
      method: 'POST',
      url: '/api/v1/drivers/status/online',
      headers: user.authHeader,
      payload: {},
    });
    assert.equal(online.statusCode, 200, online.payload);
    const located = await app.inject({
      method: 'POST',
      url: '/api/v1/drivers/location',
      headers: user.authHeader,
      payload: CENTRE,
    });
    assert.equal(located.statusCode, 200, located.payload);
    return { ...user, driverId };
  }

  async function silence(driverId: string, status = 'ONLINE') {
    await db().client.driverOnlineStatus.update({
      where: { driverId },
      data: { heartbeatAt: STALE, status: status as 'ONLINE' },
    });
  }

  const statusOf = async (driverId: string) =>
    (await db().client.driverOnlineStatus.findUniqueOrThrow({ where: { driverId } })).status;

  it('takes a silent driver offline, ends the shift and removes them from dispatch', async () => {
    const d = await onlineDriver();
    assert.ok(await geo().liveDriverPosition(d.driverId), 'in the live index while online');
    await silence(d.driverId);

    assert.equal(await job().run(), 1);

    assert.equal(await statusOf(d.driverId), 'OFFLINE');
    const driver = await db().client.driver.findUniqueOrThrow({ where: { id: d.driverId } });
    assert.equal(driver.isAvailable, false);
    const openShift = await db().client.driverShiftLog.findFirst({
      where: { driverId: d.driverId, shiftEnd: null },
    });
    assert.equal(openShift, null, 'shift closed');
    assert.equal(await geo().liveDriverPosition(d.driverId), null, 'no longer dispatchable');
  });

  it('keeps a driver whose app is still sending fixes — each fix is a heartbeat', async () => {
    const d = await onlineDriver();
    await silence(d.driverId);
    // The background location task posting while the app is not in the foreground.
    const fix = await app.inject({
      method: 'POST',
      url: '/api/v1/drivers/location',
      headers: d.authHeader,
      // Parked: the same spot, as a waiting driver's background task reports it.
      payload: CENTRE,
    });
    assert.equal(fix.statusCode, 200, fix.payload);

    assert.equal(await job().run(), 0);
    assert.equal(await statusOf(d.driverId), 'ONLINE');
  });

  it('never takes a driver on a trip offline, however long they are silent', async () => {
    const d = await onlineDriver();
    await silence(d.driverId, 'ON_TRIP');
    assert.equal(await job().run(), 0);
    assert.equal(await statusOf(d.driverId), 'ON_TRIP');
  });

  it('runs once across overlapping workers', async () => {
    const d = await onlineDriver();
    await silence(d.driverId);
    const counts = await Promise.all([job().run(), job().run()]);
    assert.equal(
      counts.reduce((a, b) => a + b, 0),
      1,
      `one worker holds the lock: ${counts.join(',')}`,
    );
    assert.equal(await statusOf(d.driverId), 'OFFLINE');
  });
});

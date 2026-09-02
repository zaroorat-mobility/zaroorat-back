import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState, type LoggedInUser } from './helpers/harness.js';
import { grantRole, makeAssignedVehicle, makeDriver } from './helpers/fixtures.js';
import { container } from '../../src/core/di.js';
import { png as image } from '../helpers/image-fixtures.js';
import type { MockStorageProvider } from '../../src/modules/files/utils/storage/mock.provider.js';
import type { GeoService } from '../../src/modules/location/core-services/geo.service.js';
import type { DocExpirationJob } from '../../src/modules/drivers/jobs/doc-expiration.job.js';
import type { NearbyDriversResult } from '../../src/modules/location/types/geo.types.js';

function png(): Buffer {
  return image({ width: 400, height: 300 });
}

const CENTRE = { latitude: 12.9716, longitude: 77.5946 };
const REQUIRED_TYPES = ['DRIVING_LICENSE', 'RC', 'INSURANCE'];

function driverIdsOf(result: NearbyDriversResult): string[] {
  return result.outcome === 'no-live-candidates' ? [] : result.drivers.map((d) => d.driverId);
}

describe('driver online activation and geo safety (integration)', () => {
  let app: FastifyInstance;
  let provider: MockStorageProvider;

  before(async () => {
    app = await bootApp();
    provider = container.resolve<MockStorageProvider>('storageProvider');
  });
  after(async () => {
    await app.close();
  });
  afterEach(async () => {
    await resetState();
    provider.reset();
  });

  async function uploadFile(auth: { authorization: string }): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/files',
      headers: { ...auth, 'idempotency-key': randomUUID() },
      payload: {
        purpose: 'DRIVER_DOCUMENT',
        fileName: 'doc.png',
        contentType: 'image/png',
        sizeBytes: 2048,
      },
    });
    assert.equal(created.statusCode, 201, created.payload);
    const fileId = created.json().fileId as string;
    const row = await db().client.file.findUniqueOrThrow({ where: { id: fileId } });
    provider.putObject(row.storageKey, png(), 'image/png');
    const completed = await app.inject({
      method: 'POST',
      url: `/api/v1/files/${fileId}/complete`,
      headers: auth,
    });
    assert.equal(completed.statusCode, 200, completed.payload);
    return fileId;
  }

  async function fullyVerifiedDriver(phone: string, adminPhone: string): Promise<LoggedInUser> {
    const user = await loginAs(app, phone);
    const me = await app.inject({
      method: 'POST',
      url: '/api/v1/drivers/me/onboard',
      headers: user.authHeader,
    });
    const driverId = me.json().data.id as string;
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/drivers/${driverId}/profile`,
      headers: user.authHeader,
      payload: { fullLegalName: 'Test Driver' },
    });
    const seed = await loginAs(app, adminPhone);
    await grantRole(seed.userId, 'admin');
    const admin = await loginAs(app, adminPhone);
    for (const documentType of REQUIRED_TYPES) {
      const fileId = await uploadFile(user.authHeader);
      const submitted = await app.inject({
        method: 'POST',
        url: `/api/v1/drivers/${driverId}/documents`,
        headers: user.authHeader,
        payload: { documentType, fileId },
      });
      const documentId = submitted.json().data.id as string;
      const reviewed = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/drivers/${driverId}/documents/${documentId}/review`,
        headers: admin.authHeader,
        payload: { status: 'VERIFIED' },
      });
      assert.equal(reviewed.statusCode, 200, reviewed.payload);
    }
    const approved = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/drivers/${driverId}/verify`,
      headers: admin.authHeader,
      payload: { status: 'VERIFIED' },
    });
    assert.equal(approved.statusCode, 200, approved.payload);
    // Going online gates on the vehicle as well as the driver: an operable
    // driver needs an active, VERIFIED vehicle with its own papers in order.
    await makeAssignedVehicle(driverId);
    return user;
  }

  function goOnline(user: LoggedInUser) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/drivers/status/online',
      headers: user.authHeader,
      payload: {},
    });
  }

  function postLocation(user: LoggedInUser, point: { latitude: number; longitude: number }) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/drivers/location',
      headers: user.authHeader,
      payload: point,
    });
  }

  it('refuses online before any document has been verified', async () => {
    const user = await loginAs(app, '+919876680001');
    await app.inject({
      method: 'POST',
      url: '/api/v1/drivers/me/onboard',
      headers: user.authHeader,
    });

    const response = await goOnline(user);

    assert.equal(response.statusCode, 403, response.payload);
  });

  it('succeeds once every required document is VERIFIED and unexpired', async () => {
    const user = await fullyVerifiedDriver('+919876680002', '+919876680003');

    const response = await goOnline(user);

    assert.equal(response.statusCode, 200, response.payload);
  });

  it('stores location for an unverified driver but never publishes it to the live geo index', async () => {
    const user = await loginAs(app, '+919876680004');
    const me = await app.inject({
      method: 'POST',
      url: '/api/v1/drivers/me/onboard',
      headers: user.authHeader,
    });
    const driverId = me.json().data.id as string;

    const posted = await postLocation(user, CENTRE);
    assert.equal(posted.statusCode, 200, posted.payload);

    const stored = await db().client.driverLocation.findUnique({ where: { driverId } });
    assert.ok(stored, 'durable row is written unconditionally');

    const geo = container.resolve<GeoService>('geoService');
    const result = await geo.findNearbyDrivers({ origin: CENTRE, radiusMeters: 1000 });
    assert.equal(driverIdsOf(result).includes(driverId), false);
  });

  it('publishes location for a fully verified, online driver', async () => {
    const user = await fullyVerifiedDriver('+919876680005', '+919876680006');
    const online = await goOnline(user);
    assert.equal(online.statusCode, 200, online.payload);

    const posted = await postLocation(user, CENTRE);
    assert.equal(posted.statusCode, 200, posted.payload);

    const geo = container.resolve<GeoService>('geoService');
    const result = await geo.findNearbyDrivers({ origin: CENTRE, radiusMeters: 1000 });
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/drivers/me',
      headers: user.authHeader,
    });
    assert.ok(driverIdsOf(result).includes(me.json().data.id));
  });

  it('a suspended driver’s posted location never appears in findNearbyDrivers', async () => {
    const customer = await loginAs(app, '+919876680007');
    const driverId = await makeDriver(customer.userId, { verified: true, suspended: true });

    const posted = await postLocation(customer, CENTRE);
    assert.equal(posted.statusCode, 200, posted.payload);

    const geo = container.resolve<GeoService>('geoService');
    const result = await geo.findNearbyDrivers({ origin: CENTRE, radiusMeters: 1000 });
    assert.equal(driverIdsOf(result).includes(driverId), false);
  });

  it('forces a driver offline and off the live index when a required document expires', async () => {
    const user = await fullyVerifiedDriver('+919876680008', '+919876680009');
    const online = await goOnline(user);
    assert.equal(online.statusCode, 200, online.payload);
    await postLocation(user, CENTRE);

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/drivers/me',
      headers: user.authHeader,
    });
    const driverId = me.json().data.id as string;
    await db().client.driverDocument.updateMany({
      where: { driverId, documentType: 'DRIVING_LICENSE' },
      data: { expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    });

    await container.resolve<DocExpirationJob>('docExpirationJob').run();

    const driver = await db().client.driver.findUniqueOrThrow({ where: { id: driverId } });
    assert.equal(driver.verificationStatus, 'DOCUMENT_REVIEW');
    const status = await db().client.driverOnlineStatus.findUnique({ where: { driverId } });
    assert.equal(status?.status, 'OFFLINE');

    const geo = container.resolve<GeoService>('geoService');
    const result = await geo.findNearbyDrivers({ origin: CENTRE, radiusMeters: 1000 });
    assert.equal(driverIdsOf(result).includes(driverId), false);
  });
});

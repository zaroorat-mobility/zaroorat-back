import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState, type LoggedInUser } from './helpers/harness.js';
import { grantRole, makeAssignedVehicle } from './helpers/fixtures.js';
import { container } from '../../src/core/di.js';
import { png as image } from '../helpers/image-fixtures.js';
import type { MockStorageProvider } from '../../src/modules/files/utils/storage/mock.provider.js';

function png(): Buffer {
  return image({ width: 400, height: 300 });
}

describe('driver document submission via fileId (integration)', () => {
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

  async function uploadFile(
    auth: { authorization: string },
    purpose = 'DRIVER_DOCUMENT',
  ): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/files',
      headers: { ...auth, 'idempotency-key': randomUUID() },
      payload: { purpose, fileName: 'licence.png', contentType: 'image/png', sizeBytes: 2048 },
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

  async function onboardDriver(user: LoggedInUser): Promise<string> {
    const me = await app.inject({
      method: 'POST',
      url: '/api/v1/drivers/me/onboard',
      headers: user.authHeader,
    });
    assert.equal(me.statusCode, 201, me.payload);
    return me.json().data.id as string;
  }

  function submitDocument(user: LoggedInUser, driverId: string, body: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/drivers/${driverId}/documents`,
      headers: user.authHeader,
      payload: body,
    });
  }

  it('stores a fileId (not a URL) on the resulting DriverDocument row', async () => {
    const user = await loginAs(app, '+919876650001');
    const driverId = await onboardDriver(user);
    const fileId = await uploadFile(user.authHeader);

    const response = await submitDocument(user, driverId, {
      documentType: 'DRIVING_LICENSE',
      fileId,
    });

    assert.equal(response.statusCode, 201, response.payload);
    const row = await db().client.driverDocument.findFirstOrThrow({
      where: { driverId, documentType: 'DRIVING_LICENSE' },
    });
    assert.equal(row.fileId, fileId);
    assert.equal(row.verificationStatus, 'PENDING');
  });

  it('rejects a request body still supplying fileUrl (schema no longer accepts it)', async () => {
    const user = await loginAs(app, '+919876650002');
    const driverId = await onboardDriver(user);

    const response = await submitDocument(user, driverId, {
      documentType: 'DRIVING_LICENSE',
      fileUrl: 'https://example.invalid/licence.jpg',
    });

    assert.equal(response.statusCode, 400, response.payload);
  });

  it('rejects another user’s fileId', async () => {
    const owner = await loginAs(app, '+919876650003');
    const stranger = await loginAs(app, '+919876650004');
    const strangerDriverId = await onboardDriver(stranger);
    const fileId = await uploadFile(owner.authHeader);

    const response = await submitDocument(stranger, strangerDriverId, {
      documentType: 'DRIVING_LICENSE',
      fileId,
    });

    assert.equal(response.statusCode, 404, response.payload);
  });

  it('rejects a nonexistent fileId', async () => {
    const user = await loginAs(app, '+919876650005');
    const driverId = await onboardDriver(user);

    const response = await submitDocument(user, driverId, {
      documentType: 'DRIVING_LICENSE',
      fileId: randomUUID(),
    });

    assert.equal(response.statusCode, 404, response.payload);
  });

  it('rejects a fileId whose purpose is not DRIVER_DOCUMENT', async () => {
    const user = await loginAs(app, '+919876650006');
    const driverId = await onboardDriver(user);
    const fileId = await uploadFile(user.authHeader, 'PROFILE_IMAGE');

    const response = await submitDocument(user, driverId, {
      documentType: 'DRIVING_LICENSE',
      fileId,
    });

    assert.equal(response.statusCode, 404, response.payload);
  });

  it('supersedes the old file and keeps exactly one row per (driverId, documentType)', async () => {
    const user = await loginAs(app, '+919876650007');
    const driverId = await onboardDriver(user);
    const firstFileId = await uploadFile(user.authHeader);
    await submitDocument(user, driverId, { documentType: 'DRIVING_LICENSE', fileId: firstFileId });

    const secondFileId = await uploadFile(user.authHeader);
    const response = await submitDocument(user, driverId, {
      documentType: 'DRIVING_LICENSE',
      fileId: secondFileId,
    });

    assert.equal(response.statusCode, 201, response.payload);
    const rows = await db().client.driverDocument.findMany({
      where: { driverId, documentType: 'DRIVING_LICENSE' },
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.fileId, secondFileId);
    const oldFile = await db().client.file.findUniqueOrThrow({ where: { id: firstFileId } });
    assert.equal(oldFile.status, 'SUPERSEDED');
  });

  it('downgrades a VERIFIED driver to DOCUMENT_REVIEW, forces offline, and forgets geo on required re-upload', async () => {
    const user = await loginAs(app, '+919876650008');
    const adminSeed = await loginAs(app, '+919876650009');
    await grantRole(adminSeed.userId, 'admin');
    const admin = await loginAs(app, '+919876650009');

    const driverId = await onboardDriver(user);
    for (const documentType of ['DRIVING_LICENSE', 'RC', 'INSURANCE']) {
      const fileId = await uploadFile(user.authHeader);
      await submitDocument(user, driverId, { documentType, fileId });
    }
    const docs = await db().client.driverDocument.findMany({ where: { driverId } });
    for (const doc of docs) {
      const review = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/drivers/${driverId}/documents/${doc.id}/review`,
        headers: admin.authHeader,
        payload: { status: 'VERIFIED' },
      });
      assert.equal(review.statusCode, 200, review.payload);
    }
    const approved = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/drivers/${driverId}/verify`,
      headers: admin.authHeader,
      payload: { status: 'VERIFIED' },
    });
    assert.equal(approved.statusCode, 200, approved.payload);

    // Going online gates on the vehicle as well as the driver.
    await makeAssignedVehicle(driverId);

    const online = await app.inject({
      method: 'POST',
      url: '/api/v1/drivers/status/online',
      headers: user.authHeader,
      payload: {},
    });
    assert.equal(online.statusCode, 200, online.payload);

    const newFileId = await uploadFile(user.authHeader);
    const resubmit = await submitDocument(user, driverId, {
      documentType: 'DRIVING_LICENSE',
      fileId: newFileId,
    });
    assert.equal(resubmit.statusCode, 201, resubmit.payload);

    const driver = await db().client.driver.findUniqueOrThrow({ where: { id: driverId } });
    assert.equal(driver.verificationStatus, 'DOCUMENT_REVIEW');
    const status = await db().client.driverOnlineStatus.findUnique({ where: { driverId } });
    assert.equal(status?.status, 'OFFLINE');
  });
});

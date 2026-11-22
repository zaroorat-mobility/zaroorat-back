import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState, type LoggedInUser } from './helpers/harness.js';
import { grantRole } from './helpers/fixtures.js';
import { container } from '../../src/core/di.js';
import { png as image } from '../helpers/image-fixtures.js';
import type { MockStorageProvider } from '../../src/modules/files/utils/storage/mock.provider.js';

function png(): Buffer {
  return image({ width: 400, height: 300 });
}

describe('driver document review (integration)', () => {
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
        fileName: 'licence.png',
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

  async function driverWithPendingDocument(
    phone: string,
  ): Promise<{ user: LoggedInUser; driverId: string; documentId: string }> {
    const user = await loginAs(app, phone);
    const me = await app.inject({
      method: 'POST',
      url: '/api/v1/drivers/me/onboard',
      headers: user.authHeader,
    });
    const driverId = me.json().data.id as string;
    const fileId = await uploadFile(user.authHeader);
    const submitted = await app.inject({
      method: 'POST',
      url: `/api/v1/drivers/${driverId}/documents`,
      headers: user.authHeader,
      payload: { documentType: 'DRIVING_LICENSE', fileId },
    });
    return { user, driverId, documentId: submitted.json().data.id as string };
  }

  function review(
    admin: LoggedInUser,
    driverId: string,
    documentId: string,
    body: Record<string, unknown>,
  ) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/admin/drivers/${driverId}/documents/${documentId}/review`,
      headers: admin.authHeader,
      payload: body,
    });
  }

  it('lets an admin verify a document, recording verifiedBy/verifiedAt', async () => {
    const { driverId, documentId } = await driverWithPendingDocument('+919876660001');
    await grantRole((await loginAs(app, '+919876660002')).userId, 'admin');
    const admin = await loginAs(app, '+919876660002');

    const response = await review(admin, driverId, documentId, { status: 'VERIFIED' });

    assert.equal(response.statusCode, 200, response.payload);
    const row = await db().client.driverDocument.findUniqueOrThrow({ where: { id: documentId } });
    assert.equal(row.verificationStatus, 'VERIFIED');
    assert.equal(row.verifiedBy, admin.userId);
    assert.ok(row.verifiedAt);
  });

  it('lets an admin reject a document with a rejectionReason', async () => {
    const { driverId, documentId } = await driverWithPendingDocument('+919876660003');
    await grantRole((await loginAs(app, '+919876660004')).userId, 'admin');
    const admin = await loginAs(app, '+919876660004');

    const response = await review(admin, driverId, documentId, {
      status: 'REJECTED',
      rejectionReason: 'Blurry photo',
    });

    assert.equal(response.statusCode, 200, response.payload);
    const row = await db().client.driverDocument.findUniqueOrThrow({ where: { id: documentId } });
    assert.equal(row.verificationStatus, 'REJECTED');
    assert.equal(row.rejectionReason, 'Blurry photo');
  });

  it('refuses a rejection without a rejectionReason (schema)', async () => {
    const { driverId, documentId } = await driverWithPendingDocument('+919876660005');
    await grantRole((await loginAs(app, '+919876660006')).userId, 'admin');
    const admin = await loginAs(app, '+919876660006');

    const response = await review(admin, driverId, documentId, { status: 'REJECTED' });

    assert.equal(response.statusCode, 400, response.payload);
  });

  it('refuses a non-admin caller', async () => {
    const { driverId, documentId } = await driverWithPendingDocument('+919876660007');
    const customer = await loginAs(app, '+919876660008');

    const response = await review(customer, driverId, documentId, { status: 'VERIFIED' });

    assert.equal(response.statusCode, 403, response.payload);
  });

  it('refuses the driver reviewing their own document', async () => {
    const { user, driverId, documentId } = await driverWithPendingDocument('+919876660009');
    await grantRole(user.userId, 'admin');
    const selfAdmin = await loginAs(app, '+919876660009');

    const response = await review(selfAdmin, driverId, documentId, { status: 'VERIFIED' });

    assert.equal(response.statusCode, 403, response.payload);
    assert.equal(response.json().error.code, 'SELF_REVIEW_FORBIDDEN');
  });

  it('returns 404 for a nonexistent documentId', async () => {
    const { driverId } = await driverWithPendingDocument('+919876660010');
    await grantRole((await loginAs(app, '+919876660011')).userId, 'admin');
    const admin = await loginAs(app, '+919876660011');

    const response = await review(admin, driverId, randomUUID(), { status: 'VERIFIED' });

    assert.equal(response.statusCode, 404, response.payload);
  });

  it('returns 409 when the documentId does not belong to the URL’s driverId', async () => {
    const first = await driverWithPendingDocument('+919876660012');
    const second = await driverWithPendingDocument('+919876660013');
    await grantRole((await loginAs(app, '+919876660014')).userId, 'admin');
    const admin = await loginAs(app, '+919876660014');

    const response = await review(admin, first.driverId, second.documentId, { status: 'VERIFIED' });

    assert.equal(response.statusCode, 409, response.payload);
  });

  it('is idempotent when re-reviewed with the same status', async () => {
    const { driverId, documentId } = await driverWithPendingDocument('+919876660015');
    await grantRole((await loginAs(app, '+919876660016')).userId, 'admin');
    const admin = await loginAs(app, '+919876660016');

    const first = await review(admin, driverId, documentId, { status: 'VERIFIED' });
    assert.equal(first.statusCode, 200, first.payload);
    const firstVerifiedAt = (
      await db().client.driverDocument.findUniqueOrThrow({ where: { id: documentId } })
    ).verifiedAt;

    const second = await review(admin, driverId, documentId, { status: 'VERIFIED' });
    assert.equal(second.statusCode, 200, second.payload);
    const row = await db().client.driverDocument.findUniqueOrThrow({ where: { id: documentId } });
    assert.deepEqual(row.verifiedAt, firstVerifiedAt);
  });
});

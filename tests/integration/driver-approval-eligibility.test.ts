import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState, type LoggedInUser } from './helpers/harness.js';
import { grantRole } from './helpers/fixtures.js';
import { container } from '../../src/core/di.js';
import { png as image } from '../helpers/image-fixtures.js';
import type { MockStorageProvider } from '../../src/modules/files/utils/storage/mock.provider.js';
import type { OutboxRelay } from '../../src/core/events/OutboxRelay.js';
import type { AuthDriverVerifiedConsumer } from '../../src/modules/auth/consumers/driver-verified.consumer.js';
import type { EventEnvelope } from '../../src/core/events/index.js';

function png(): Buffer {
  return image({ width: 400, height: 300 });
}

const REQUIRED_TYPES = ['DRIVING_LICENSE', 'RC', 'INSURANCE'];

describe('driver approval eligibility gate and role propagation (integration)', () => {
  let app: FastifyInstance;
  let provider: MockStorageProvider;

  before(async () => {
    app = await bootApp();
    provider = container.resolve<MockStorageProvider>('storageProvider');
    container.resolve<AuthDriverVerifiedConsumer>('authDriverVerifiedConsumer').register();
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

  async function onboard(user: LoggedInUser): Promise<string> {
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/drivers/me',
      headers: user.authHeader,
    });
    return me.json().data.id as string;
  }

  async function submitDocument(
    user: LoggedInUser,
    driverId: string,
    documentType: string,
    expiresAt?: string,
  ): Promise<string> {
    const fileId = await uploadFile(user.authHeader);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/drivers/${driverId}/documents`,
      headers: user.authHeader,
      payload: { documentType, fileId, ...(expiresAt ? { expiresAt } : {}) },
    });
    assert.equal(response.statusCode, 201, response.payload);
    return response.json().data.id as string;
  }

  async function reviewDocument(
    admin: LoggedInUser,
    driverId: string,
    documentId: string,
    status: string,
  ) {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/drivers/${driverId}/documents/${documentId}/review`,
      headers: admin.authHeader,
      payload: status === 'REJECTED' ? { status, rejectionReason: 'bad scan' } : { status },
    });
    assert.equal(response.statusCode, 200, response.payload);
  }

  function approve(admin: LoggedInUser, driverId: string) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/drivers/${driverId}/verify`,
      headers: admin.authHeader,
      payload: { status: 'VERIFIED' },
    });
  }

  async function makeAdmin(phone: string): Promise<LoggedInUser> {
    const seed = await loginAs(app, phone);
    await grantRole(seed.userId, 'admin');
    return loginAs(app, phone);
  }

  it('blocks approval with 422 and details.missing when zero documents are submitted', async () => {
    const user = await loginAs(app, '+919876670001');
    const driverId = await onboard(user);
    const admin = await makeAdmin('+919876670002');

    const response = await approve(admin, driverId);

    assert.equal(response.statusCode, 422, response.payload);
    assert.deepEqual([...response.json().error.details.missing].sort(), [...REQUIRED_TYPES].sort());
  });

  it('blocks approval with 422 and details.pending when a required document is still PENDING', async () => {
    const user = await loginAs(app, '+919876670003');
    const driverId = await onboard(user);
    const admin = await makeAdmin('+919876670004');
    for (const documentType of REQUIRED_TYPES) {
      await submitDocument(user, driverId, documentType);
    }

    const response = await approve(admin, driverId);

    assert.equal(response.statusCode, 422, response.payload);
    assert.equal(response.json().error.details.pending.length, REQUIRED_TYPES.length);
  });

  it('blocks approval with 422 and details.rejected when a required document is REJECTED', async () => {
    const user = await loginAs(app, '+919876670005');
    const driverId = await onboard(user);
    const admin = await makeAdmin('+919876670006');
    const documentIds: string[] = [];
    for (const documentType of REQUIRED_TYPES) {
      documentIds.push(await submitDocument(user, driverId, documentType));
    }
    await reviewDocument(admin, driverId, documentIds[0]!, 'REJECTED');
    await reviewDocument(admin, driverId, documentIds[1]!, 'VERIFIED');
    await reviewDocument(admin, driverId, documentIds[2]!, 'VERIFIED');

    const response = await approve(admin, driverId);

    assert.equal(response.statusCode, 422, response.payload);
    assert.equal(response.json().error.details.rejected.length, 1);
  });

  it('blocks approval with 422 and details.expired when a required document is VERIFIED but expired', async () => {
    const user = await loginAs(app, '+919876670007');
    const driverId = await onboard(user);
    const admin = await makeAdmin('+919876670008');
    const documentIds: string[] = [];
    documentIds.push(
      await submitDocument(
        user,
        driverId,
        'DRIVING_LICENSE',
        new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      ),
    );
    documentIds.push(await submitDocument(user, driverId, 'RC'));
    documentIds.push(await submitDocument(user, driverId, 'INSURANCE'));
    for (const documentId of documentIds) {
      await reviewDocument(admin, driverId, documentId, 'VERIFIED');
    }

    const response = await approve(admin, driverId);

    assert.equal(response.statusCode, 422, response.payload);
    assert.equal(response.json().error.details.expired.length, 1);
  });

  it('approves, propagates the driver role via the outbox, and survives duplicate delivery', async () => {
    const user = await loginAs(app, '+919876670009');
    const driverId = await onboard(user);
    const admin = await makeAdmin('+919876670010');
    const documentIds: string[] = [];
    for (const documentType of REQUIRED_TYPES) {
      documentIds.push(await submitDocument(user, driverId, documentType));
    }
    for (const documentId of documentIds) {
      await reviewDocument(admin, driverId, documentId, 'VERIFIED');
    }

    const approved = await approve(admin, driverId);
    assert.equal(approved.statusCode, 200, approved.payload);

    const outboxRows = await db().client.outboxEvent.findMany({
      where: { eventType: 'driver.verified' },
    });
    assert.equal(outboxRows.length, 1);
    const payload = outboxRows[0]!.payload as unknown as { data: { userId: string } };
    assert.equal(payload.data.userId, user.userId);

    await container.resolve<OutboxRelay>('outboxRelay').processBatch(100);

    const driverRole = await db().client.role.findUniqueOrThrow({ where: { slug: 'driver' } });
    const assignments = () =>
      db().client.userRoleAssignment.findMany({
        where: { userId: user.userId, roleId: driverRole.id, revokedAt: null },
      });
    assert.equal((await assignments()).length, 1);

    const refreshed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/token/refresh',
      headers: { 'idempotency-key': randomUUID() },
      payload: { refreshToken: user.refreshToken },
    });
    assert.equal(refreshed.statusCode, 200, refreshed.payload);
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: { authorization: `Bearer ${refreshed.json().accessToken}` },
    });
    assert.ok([...me.json().roles].includes('driver'));

    const consumer = container.resolve<AuthDriverVerifiedConsumer>('authDriverVerifiedConsumer');
    const envelope = {
      eventId: randomUUID(),
      type: 'driver.verified',
      data: { driverId, approvedBy: admin.userId, userId: user.userId },
    } as unknown as EventEnvelope;
    await (consumer as unknown as { handle: (e: EventEnvelope) => Promise<void> }).handle(envelope);

    assert.equal((await assignments()).length, 1, 'duplicate delivery is a no-op');
  });

  it('re-approving an already-VERIFIED driver is a 200 idempotent no-op with no second outbox row', async () => {
    const user = await loginAs(app, '+919876670011');
    const driverId = await onboard(user);
    const admin = await makeAdmin('+919876670012');
    const documentIds: string[] = [];
    for (const documentType of REQUIRED_TYPES) {
      documentIds.push(await submitDocument(user, driverId, documentType));
    }
    for (const documentId of documentIds) {
      await reviewDocument(admin, driverId, documentId, 'VERIFIED');
    }
    const first = await approve(admin, driverId);
    assert.equal(first.statusCode, 200, first.payload);

    const second = await approve(admin, driverId);

    assert.equal(second.statusCode, 200, second.payload);
    const outboxRows = await db().client.outboxEvent.findMany({
      where: { eventType: 'driver.verified' },
    });
    assert.equal(outboxRows.length, 1);
  });
});

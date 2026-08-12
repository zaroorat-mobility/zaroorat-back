import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { container } from '../../src/core/di.js';
import { png as image } from '../helpers/image-fixtures.js';
import {
  clearFileReferences,
  registerFileReference,
} from '../../src/modules/files/references/file-references.js';
import type { MockStorageProvider } from '../../src/modules/files/providers/mock.provider.js';

function png(): Buffer {
  return image({ width: 800, height: 600 });
}

describe('file lifecycle (integration)', () => {
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
    clearFileReferences();
  });

  function createUpload(auth: { authorization: string }, purpose = 'PROFILE_IMAGE') {
    return app.inject({
      method: 'POST',
      url: '/api/v1/files',
      headers: { ...auth, 'idempotency-key': randomUUID() },
      payload: { purpose, fileName: 'me.png', contentType: 'image/png', sizeBytes: 2048 },
    });
  }

  async function publish(
    auth: { authorization: string },
    purpose = 'PROFILE_IMAGE',
  ): Promise<{ fileId: string; storageKey: string }> {
    const created = await createUpload(auth, purpose);
    const fileId = created.json().fileId as string;
    const row = await db().client.file.findUniqueOrThrow({ where: { id: fileId } });
    provider.putObject(row.storageKey, png(), 'image/png');
    const completed = await app.inject({
      method: 'POST',
      url: `/api/v1/files/${fileId}/complete`,
      headers: auth,
    });
    assert.equal(completed.statusCode, 200, completed.payload);
    return { fileId, storageKey: row.storageKey };
  }

  function remove(auth: { authorization: string }, fileId: string) {
    return app.inject({ method: 'DELETE', url: `/api/v1/files/${fileId}`, headers: auth });
  }

  async function deletedEvents() {
    return db().client.outboxEvent.findMany({
      where: { eventType: 'file.deleted' },
      orderBy: { createdAt: 'asc' },
    });
  }

  describe('deleting a file the caller owns', () => {
    it('answers 204 and soft-deletes the row', async () => {
      const user = await loginAs(app, '+919876570001');
      const { fileId } = await publish(user.authHeader);

      const response = await remove(user.authHeader, fileId);

      assert.equal(response.statusCode, 204);
      assert.equal(response.payload, '');
      const row = await db().client.file.findUniqueOrThrow({ where: { id: fileId } });
      assert.equal(row.status, 'DELETED');
      assert.notEqual(row.deletedAt, null);
    });

    it('removes it from every read path immediately', async () => {
      const user = await loginAs(app, '+919876570002');
      const { fileId } = await publish(user.authHeader);
      await remove(user.authHeader, fileId);

      const url = await app.inject({
        method: 'GET',
        url: `/api/v1/files/${fileId}/url`,
        headers: user.authHeader,
      });
      const metadata = await app.inject({
        method: 'GET',
        url: `/api/v1/files/${fileId}`,
        headers: user.authHeader,
      });

      assert.equal(url.statusCode, 404);
      assert.equal(metadata.statusCode, 404);
      assert.equal(url.json().error.code, 'NOT_FOUND');
    });

    it('leaves the object in storage, unerased (criterion #9)', async () => {
      const user = await loginAs(app, '+919876570003');
      const { fileId, storageKey } = await publish(user.authHeader);

      await remove(user.authHeader, fileId);

      assert.notEqual(await provider.head(storageKey, 8), null, 'the object survives');
      const row = await db().client.file.findUniqueOrThrow({ where: { id: fileId } });
      assert.equal(row.erasedAt, null);
      assert.equal(row.archivedAt, null);
    });

    it('stops counting the bytes against the user’s quota', async () => {
      const user = await loginAs(app, '+919876570004');
      const { fileId } = await publish(user.authHeader);

      await remove(user.authHeader, fileId);

      const live = await db().client.file.aggregate({
        where: { ownerUserId: user.userId, deletedAt: null, status: { in: ['PENDING', 'READY'] } },
        _sum: { sizeBytes: true },
      });
      assert.equal(live._sum.sizeBytes, null);
    });
  });

  describe('repeating or misdirecting a delete', () => {
    it('answers 204 again, and emits exactly one event', async () => {
      const user = await loginAs(app, '+919876570010');
      const { fileId } = await publish(user.authHeader);

      assert.equal((await remove(user.authHeader, fileId)).statusCode, 204);
      assert.equal((await remove(user.authHeader, fileId)).statusCode, 204);

      assert.equal((await deletedEvents()).length, 1);
    });

    it('answers 404 for another user’s file, and does not delete it', async () => {
      const owner = await loginAs(app, '+919876570011');
      const stranger = await loginAs(app, '+919876570012');
      const { fileId } = await publish(owner.authHeader);

      const response = await remove(stranger.authHeader, fileId);

      assert.equal(response.statusCode, 404);
      const row = await db().client.file.findUniqueOrThrow({ where: { id: fileId } });
      assert.equal(row.status, 'READY');
    });

    it('answers 404 for an id that never existed', async () => {
      const user = await loginAs(app, '+919876570013');
      assert.equal((await remove(user.authHeader, randomUUID())).statusCode, 404);
    });

    it('refuses a PENDING reservation — it is not a file yet', async () => {
      const user = await loginAs(app, '+919876570014');
      const fileId = (await createUpload(user.authHeader)).json().fileId as string;

      const response = await remove(user.authHeader, fileId);

      assert.equal(response.statusCode, 404);
      const row = await db().client.file.findUniqueOrThrow({ where: { id: fileId } });
      assert.equal(row.status, 'PENDING');
    });

    it('refuses a SUPERSEDED file — evidence cannot be withdrawn', async () => {
      const user = await loginAs(app, '+919876570015');
      const previous = await publish(user.authHeader, 'DRIVER_DOCUMENT');
      const replacement = await publish(user.authHeader, 'DRIVER_DOCUMENT');
      await db().client.file.update({
        where: { id: previous.fileId },
        data: { status: 'SUPERSEDED', supersededById: replacement.fileId },
      });

      const response = await remove(user.authHeader, previous.fileId);

      assert.equal(response.statusCode, 404);
      const row = await db().client.file.findUniqueOrThrow({ where: { id: previous.fileId } });
      assert.equal(row.status, 'SUPERSEDED');
    });

    it('requires authentication like every other route in the module', async () => {
      const user = await loginAs(app, '+919876570016');
      const { fileId } = await publish(user.authHeader);

      const response = await app.inject({ method: 'DELETE', url: `/api/v1/files/${fileId}` });

      assert.equal(response.statusCode, 401);
    });
  });

  describe('when a live domain row still references the file', () => {
    it('answers 409 FILE_IN_USE and names the holding module', async () => {
      const user = await loginAs(app, '+919876570020');
      const { fileId } = await publish(user.authHeader);
      registerFileReference('PROFILE_IMAGE', {
        module: 'users',
        isReferenced: async (id) => id === fileId,
      });

      const response = await remove(user.authHeader, fileId);

      assert.equal(response.statusCode, 409);
      assert.equal(response.json().error.code, 'FILE_IN_USE');
      assert.equal(response.json().error.module, 'users');
      const row = await db().client.file.findUniqueOrThrow({ where: { id: fileId } });
      assert.equal(row.status, 'READY', 'the row is untouched');
    });

    it('names the module and nothing else', async () => {
      const user = await loginAs(app, '+919876570021');
      const { fileId, storageKey } = await publish(user.authHeader);
      registerFileReference('PROFILE_IMAGE', { module: 'users', isReferenced: async () => true });

      const payload = (await remove(user.authHeader, fileId)).payload;

      assert.equal(payload.includes(storageKey), false);
      assert.equal(payload.includes('driver_documents'), false);
    });

    it('succeeds once the module releases it', async () => {
      const user = await loginAs(app, '+919876570022');
      const { fileId } = await publish(user.authHeader);
      let attached = true;
      registerFileReference('PROFILE_IMAGE', {
        module: 'users',
        isReferenced: async () => attached,
      });

      assert.equal((await remove(user.authHeader, fileId)).statusCode, 409);
      attached = false;
      assert.equal((await remove(user.authHeader, fileId)).statusCode, 204);
    });
  });

  describe('a second live profile image', () => {
    async function attempt(auth: { authorization: string }) {
      const created = await createUpload(auth);
      const fileId = created.json().fileId as string;
      const row = await db().client.file.findUniqueOrThrow({ where: { id: fileId } });
      provider.putObject(row.storageKey, png(), 'image/png');
      const completed = await app.inject({
        method: 'POST',
        url: `/api/v1/files/${fileId}/complete`,
        headers: auth,
      });
      return { fileId, completed };
    }

    it('completes, because the replacement must exist before it can supersede', async () => {
      const user = await loginAs(app, '+919876570040');
      await publish(user.authHeader);

      const { completed } = await attempt(user.authHeader);

      assert.equal(completed.statusCode, 200, completed.payload);
      assert.equal(completed.json().status, 'READY');
    });

    it('leaves the previous one READY until something attaches the new one', async () => {
      const user = await loginAs(app, '+919876570041');
      const { fileId: firstId } = await publish(user.authHeader);
      const { fileId: secondId } = await attempt(user.authHeader);

      const first = await db().client.file.findUniqueOrThrow({ where: { id: firstId } });
      const second = await db().client.file.findUniqueOrThrow({ where: { id: secondId } });
      assert.equal(first.status, 'READY');
      assert.equal(first.supersededById, null);
      assert.equal(second.status, 'READY');
    });
  });

  describe('the file.deleted event', () => {
    it('is written in the same transaction as the row change', async () => {
      const user = await loginAs(app, '+919876570030');
      const { fileId } = await publish(user.authHeader);

      await remove(user.authHeader, fileId);

      const [event] = await deletedEvents();
      assert.ok(event, 'the audit record exists');
      assert.equal(event.aggregateId, fileId);
      const envelope = event.payload as { producer: string; subject: { userId: string } };
      assert.equal(envelope.subject.userId, user.userId);
      assert.equal(envelope.producer, 'files');
    });

    it('carries the coarse actor and the accountable id', async () => {
      const user = await loginAs(app, '+919876570031');
      const { fileId } = await publish(user.authHeader);
      await remove(user.authHeader, fileId);

      const [event] = await deletedEvents();
      const data = (event?.payload as { data: Record<string, unknown> }).data;

      assert.deepEqual(data, {
        fileId,
        ownerUserId: user.userId,
        purpose: 'PROFILE_IMAGE',
        actor: 'self',
        actorUserId: user.userId,
      });
    });

    it('carries no URL, key, checksum, or filename (doc 05 §4)', async () => {
      const user = await loginAs(app, '+919876570032');
      const { fileId, storageKey } = await publish(user.authHeader);
      await remove(user.authHeader, fileId);

      const [event] = await deletedEvents();
      const serialized = JSON.stringify(event?.payload);

      assert.equal(serialized.includes(storageKey), false);
      assert.equal(serialized.includes('me.png'), false);
      assert.equal(serialized.includes('X-Mock-Signature'), false);
    });
  });
});

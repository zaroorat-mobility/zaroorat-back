import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { container } from '../../src/core/di.js';
import { png as image } from '../helpers/image-fixtures.js';
import type { MockStorageProvider } from '../../src/modules/files/providers/mock.provider.js';

function png(width: number, height: number, padTo = 0): Buffer {
  const base = image({ width, height });
  return padTo > base.length ? Buffer.concat([base, Buffer.alloc(padTo - base.length)]) : base;
}

const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x00, 0x00]);

describe('file upload (integration)', () => {
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

  function request(
    auth: { authorization: string },
    body: Record<string, unknown>,
    key = randomUUID(),
  ) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/files',
      headers: { ...auth, 'idempotency-key': key },
      payload: body,
    });
  }

  function complete(auth: { authorization: string }, fileId: string) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/files/${fileId}/complete`,
      headers: auth,
    });
  }

  const PROFILE_BODY = {
    purpose: 'PROFILE_IMAGE',
    fileName: 'me.png',
    contentType: 'image/png',
    sizeBytes: 2048,
  };

  async function uploadPng(
    auth: { authorization: string },
    dimensions: [number, number] = [800, 600],
  ): Promise<{ fileId: string; key: string }> {
    const created = await request(auth, PROFILE_BODY);
    const fileId = created.json().fileId as string;
    const row = await db().client.file.findUniqueOrThrow({ where: { id: fileId } });
    provider.putObject(row.storageKey, png(...dimensions), 'image/png');
    return { fileId, key: row.storageKey };
  }

  describe('POST /files', () => {
    it('reserves a PENDING row and returns a scoped permission', async () => {
      const user = await loginAs(app, '+919876540001');

      const response = await request(user.authHeader, PROFILE_BODY);

      assert.equal(response.statusCode, 201);
      const body = response.json();
      assert.equal(body.status, 'PENDING');
      assert.equal(body.upload.method, 'PUT');
      assert.deepEqual(body.upload.headers, { 'Content-Type': 'image/png' });

      const row = await db().client.file.findUniqueOrThrow({ where: { id: body.fileId } });
      assert.equal(row.status, 'PENDING');
      assert.equal(row.ownerUserId, user.userId);
      assert.equal(row.storageProvider, 'mock');
    });

    it('never returns the storage key, and the key never contains the filename', async () => {
      const user = await loginAs(app, '+919876540002');

      const response = await request(user.authHeader, {
        ...PROFILE_BODY,
        fileName: '../../etc/passwd.png',
      });

      const row = await db().client.file.findUniqueOrThrow({
        where: { id: response.json().fileId },
      });
      assert.equal(response.payload.includes(row.storageKey), false, 'FILE-INV-2');
      assert.equal(row.storageKey.includes('passwd'), false);
      assert.equal(row.fileName, 'passwd.png', 'kept for display, sanitized');
    });

    it('refuses a type the purpose does not permit, naming what is allowed', async () => {
      const user = await loginAs(app, '+919876540003');

      const response = await request(user.authHeader, {
        ...PROFILE_BODY,
        contentType: 'application/pdf',
      });

      assert.equal(response.statusCode, 415);
      assert.equal(response.json().error.code, 'UNSUPPORTED_MEDIA_TYPE');
      assert.deepEqual(response.json().error.details[0].allowed, [
        'image/jpeg',
        'image/png',
        'image/webp',
      ]);
    });

    it('refuses a declared size over the ceiling before signing anything', async () => {
      const user = await loginAs(app, '+919876540004');

      const response = await request(user.authHeader, {
        ...PROFILE_BODY,
        sizeBytes: 50 * 1024 * 1024,
      });

      assert.equal(response.statusCode, 413);
      assert.equal(response.json().error.code, 'FILE_TOO_LARGE');
      assert.equal(await db().client.file.count(), 0, 'no row was reserved');
    });

    it('requires an Idempotency-Key, since a retry would orphan an object', async () => {
      const user = await loginAs(app, '+919876540005');

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/files',
        headers: user.authHeader,
        payload: PROFILE_BODY,
      });

      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error.code, 'VALIDATION');
    });

    it('rejects an unknown key rather than silently dropping it', async () => {
      const user = await loginAs(app, '+919876540006');

      const response = await request(user.authHeader, { ...PROFILE_BODY, isPublic: true });

      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error.code, 'VALIDATION');
    });

    it('is closed to unauthenticated callers', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/files',
        headers: { 'idempotency-key': randomUUID() },
        payload: PROFILE_BODY,
      });
      assert.equal(response.statusCode, 401);
    });
  });

  describe('POST /files/:id/complete', () => {
    it('verifies the bytes, publishes the file, and emits one event', async () => {
      const user = await loginAs(app, '+919876540010');
      const { fileId } = await uploadPng(user.authHeader);

      const response = await complete(user.authHeader, fileId);

      assert.equal(response.statusCode, 200);
      assert.equal(response.json().status, 'READY');

      const row = await db().client.file.findUniqueOrThrow({ where: { id: fileId } });
      assert.equal(row.status, 'READY');
      assert.ok(row.completedAt, 'ck_files_ready_is_complete would have refused otherwise');

      const events = await db().client.outboxEvent.findMany({
        where: { eventType: 'file.uploaded' },
      });
      assert.equal(events.length, 1);
    });

    it('refuses an ELF renamed as a PNG, and removes the object', async () => {
      const user = await loginAs(app, '+919876540011');
      const created = await request(user.authHeader, PROFILE_BODY);
      const fileId = created.json().fileId as string;
      const row = await db().client.file.findUniqueOrThrow({ where: { id: fileId } });
      provider.putObject(row.storageKey, ELF, 'image/png');

      const response = await complete(user.authHeader, fileId);

      assert.equal(response.statusCode, 422);
      assert.equal(response.json().error.code, 'CONTENT_MISMATCH');

      assert.equal(await provider.head(row.storageKey, 32), null);

      const after = await db().client.file.findUniqueOrThrow({ where: { id: fileId } });
      assert.equal(after.status, 'EXPIRED', 'the reservation is retired, not left retriable');
    });

    it('refuses a decompression bomb on pixel count, not bytes', async () => {
      const user = await loginAs(app, '+919876540012');
      const created = await request(user.authHeader, PROFILE_BODY);
      const fileId = created.json().fileId as string;
      const row = await db().client.file.findUniqueOrThrow({ where: { id: fileId } });

      const bomb = png(40000, 40000);
      assert.ok(bomb.length < 100);
      provider.putObject(row.storageKey, bomb, 'image/png');

      const response = await complete(user.authHeader, fileId);

      assert.equal(response.statusCode, 413);
      assert.equal(response.json().error.code, 'FILE_TOO_LARGE');
      assert.equal(response.json().error.details[0].field, 'dimensions');
    });

    it('is recoverable when the object has not arrived yet', async () => {
      const user = await loginAs(app, '+919876540013');
      const created = await request(user.authHeader, PROFILE_BODY);
      const fileId = created.json().fileId as string;

      const response = await complete(user.authHeader, fileId);

      assert.equal(response.statusCode, 409);
      assert.equal(response.json().error.code, 'UPLOAD_NOT_FOUND');
      const row = await db().client.file.findUniqueOrThrow({ where: { id: fileId } });
      assert.equal(row.status, 'PENDING', 'still retriable — the client can re-PUT');
    });

    it('replays a second completion without emitting a second event', async () => {
      const user = await loginAs(app, '+919876540014');
      const { fileId } = await uploadPng(user.authHeader);

      const first = await complete(user.authHeader, fileId);
      const second = await complete(user.authHeader, fileId);

      assert.equal(first.statusCode, 200);
      assert.equal(second.statusCode, 200);
      assert.deepEqual(first.json(), second.json());
      assert.equal(
        (await db().client.outboxEvent.findMany({ where: { eventType: 'file.uploaded' } })).length,
        1,
      );
    });

    it('lets exactly one of two concurrent completions transition (FILE-INV-6)', async () => {
      const user = await loginAs(app, '+919876540015');
      const { fileId } = await uploadPng(user.authHeader);

      const results = await Promise.all([
        complete(user.authHeader, fileId),
        complete(user.authHeader, fileId),
        complete(user.authHeader, fileId),
      ]);

      assert.deepEqual(
        results.map((r) => r.statusCode),
        [200, 200, 200],
        'every caller observes success',
      );
      const events = await db().client.outboxEvent.findMany({
        where: { eventType: 'file.uploaded' },
      });
      assert.equal(events.length, 1, 'but exactly one event exists');
    });

    it('cannot complete another user’s file, and cannot tell it exists', async () => {
      const owner = await loginAs(app, '+919876540016');
      const stranger = await loginAs(app, '+919876540017');
      const { fileId } = await uploadPng(owner.authHeader);

      const onOthers = await complete(stranger.authHeader, fileId);
      const onNothing = await complete(stranger.authHeader, randomUUID());

      assert.equal(onOthers.statusCode, 404);

      const strip = (payload: string): unknown => {
        const body = JSON.parse(payload) as { error: Record<string, unknown> };
        delete body.error.requestId;
        return body;
      };
      assert.deepEqual(strip(onOthers.payload), strip(onNothing.payload));
    });

    it('is closed to unauthenticated callers', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/files/${randomUUID()}/complete`,
      });
      assert.equal(response.statusCode, 401);
    });
  });

  describe('no byte transits the API (R-FILE-1)', () => {
    it('completes an upload without the API ever writing an object', async () => {
      const user = await loginAs(app, '+919876540020');
      const { fileId, key } = await uploadPng(user.authHeader);

      const before = { ...provider.calls };
      await complete(user.authHeader, fileId);

      assert.ok(provider.calls.signUpload >= before.signUpload);
      assert.ok(provider.calls.head > before.head);
      assert.ok(provider.versionIds(key).length > 0, 'the object exists — the client wrote it');
    });

    it('emits no signed URL or storage key into the outbox', async () => {
      const user = await loginAs(app, '+919876540021');
      const { fileId, key } = await uploadPng(user.authHeader);
      await complete(user.authHeader, fileId);

      const events = await db().client.outboxEvent.findMany({
        where: { eventType: 'file.uploaded' },
      });
      const serialized = JSON.stringify(events);
      assert.equal(serialized.includes(key), false, 'no storage key');
      assert.equal(serialized.includes('mock-storage.local'), false, 'no signed URL');
      assert.equal(serialized.includes('me.png'), false, 'no filename');
    });
  });
});

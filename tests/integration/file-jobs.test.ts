import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { container } from '../../src/core/di.js';
import { png as image } from '../helpers/image-fixtures.js';
import { fileConfig } from '../../src/config/file/file.config.js';
import {
  clearFileReferences,
  registerFileReference,
} from '../../src/modules/files/services/file-reference.service.js';
import type { FileRetentionJob } from '../../src/modules/files/jobs/retention.job.js';
import type { FileSweeperJob } from '../../src/modules/files/jobs/sweeper.job.js';
import type { MockStorageProvider } from '../../src/modules/files/utils/storage/mock.provider.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function png(): Buffer {
  return image({ width: 800, height: 600 });
}

describe('file jobs (integration)', () => {
  let app: FastifyInstance;
  let provider: MockStorageProvider;
  let sweeper: FileSweeperJob;
  let retention: FileRetentionJob;

  before(async () => {
    app = await bootApp();
    provider = container.resolve<MockStorageProvider>('storageProvider');
    sweeper = container.resolve<FileSweeperJob>('fileSweeperJob');
    retention = container.resolve<FileRetentionJob>('fileRetentionJob');
  });
  after(async () => {
    await app.close();
  });
  afterEach(async () => {
    await resetState();
    provider.reset();
    clearFileReferences();
  });

  async function reserve(
    auth: { authorization: string },
    purpose = 'PROFILE_IMAGE',
  ): Promise<{ fileId: string; storageKey: string }> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/files',
      headers: { ...auth, 'idempotency-key': randomUUID() },
      payload: { purpose, fileName: 'me.png', contentType: 'image/png', sizeBytes: 2048 },
    });
    assert.equal(created.statusCode, 201, created.payload);
    const fileId = created.json().fileId as string;
    const row = await db().client.file.findUniqueOrThrow({ where: { id: fileId } });
    return { fileId, storageKey: row.storageKey };
  }

  async function publish(
    auth: { authorization: string },
    purpose = 'PROFILE_IMAGE',
  ): Promise<{ fileId: string; storageKey: string }> {
    const file = await reserve(auth, purpose);
    provider.putObject(file.storageKey, png(), 'image/png');
    const completed = await app.inject({
      method: 'POST',
      url: `/api/v1/files/${file.fileId}/complete`,
      headers: auth,
    });
    assert.equal(completed.statusCode, 200, completed.payload);
    return file;
  }

  function afterUploadWindow(): Date {
    return new Date(Date.now() + 3600_000);
  }

  describe('the sweeper', () => {
    it('reclaims a reservation whose window closed, object and row', async () => {
      const user = await loginAs(app, '+919876590001');
      const { fileId, storageKey } = await reserve(user.authHeader);
      provider.putObject(storageKey, png(), 'image/png');

      const result = await sweeper.run(afterUploadWindow());

      assert.deepEqual(
        [result.ran, result.scanned, result.reclaimed, result.failed],
        [true, 1, 1, 0],
      );
      assert.equal(await provider.head(storageKey, 8), null);
      assert.equal(await db().client.file.findUnique({ where: { id: fileId } }), null);
    });

    it('leaves a reservation whose window is still open', async () => {
      const user = await loginAs(app, '+919876590002');
      const { fileId } = await reserve(user.authHeader);

      const result = await sweeper.run(new Date());

      assert.equal(result.reclaimed, 0);
      assert.ok(await db().client.file.findUnique({ where: { id: fileId } }));
    });

    it('never touches a READY file, however old', async () => {
      const user = await loginAs(app, '+919876590003');
      const { fileId, storageKey } = await publish(user.authHeader);

      await sweeper.run(new Date(Date.now() + 365 * DAY_MS));

      const row = await db().client.file.findUniqueOrThrow({ where: { id: fileId } });
      assert.equal(row.status, 'READY');
      assert.notEqual(await provider.head(storageKey, 8), null);
    });

    it('collects an EXPIRED row too — the state doc 01 §7 ends here', async () => {
      const user = await loginAs(app, '+919876590004');
      const { fileId, storageKey } = await reserve(user.authHeader);
      provider.putObject(storageKey, png(), 'image/png');

      // A client that comes back after its write permission lapsed. The bytes
      // are never inspected, so this is an expiry rather than a refusal — the
      // row has to reach EXPIRED for the sweeper to have anything to collect.
      await db().client.file.update({
        where: { id: fileId },
        data: { uploadExpiresAt: new Date(Date.now() - 1000) },
      });
      const late = await app.inject({
        method: 'POST',
        url: `/api/v1/files/${fileId}/complete`,
        headers: user.authHeader,
      });
      assert.equal(late.statusCode, 410, late.payload);
      assert.equal(late.json().error.code, 'UPLOAD_EXPIRED');
      assert.equal(
        (await db().client.file.findUniqueOrThrow({ where: { id: fileId } })).status,
        'EXPIRED',
      );

      await sweeper.run(afterUploadWindow());

      assert.equal(await db().client.file.findUnique({ where: { id: fileId } }), null);
    });

    it('leaves a REJECTED row alone — the refusal is the record', async () => {
      const user = await loginAs(app, '+919876590005');
      const { fileId, storageKey } = await reserve(user.authHeader);

      provider.putObject(storageKey, Buffer.from('not a png at all'), 'image/png');
      await app.inject({
        method: 'POST',
        url: `/api/v1/files/${fileId}/complete`,
        headers: user.authHeader,
      });
      const refused = await db().client.file.findUniqueOrThrow({ where: { id: fileId } });
      assert.equal(refused.status, 'REJECTED');
      assert.equal(refused.rejectedReason, 'CONTENT_MISMATCH');

      await sweeper.run(afterUploadWindow());

      // Retention destroys refused objects on the purpose's schedule; the
      // sweeper reclaims abandoned reservations, and a refusal is neither.
      assert.ok(
        await db().client.file.findUnique({ where: { id: fileId } }),
        'the durable trace of the refusal survives the sweeper',
      );
    });

    it('deletes the object before the row, so a failure is retriable', async () => {
      const user = await loginAs(app, '+919876590005');
      const { fileId, storageKey } = await reserve(user.authHeader);
      provider.putObject(storageKey, png(), 'image/png');
      provider.failNext('delete', true);

      const result = await sweeper.run(afterUploadWindow());

      assert.equal(result.failed, 1);
      assert.ok(await db().client.file.findUnique({ where: { id: fileId } }), 'row survives');
      assert.equal((await sweeper.run(afterUploadWindow())).reclaimed, 1, 'the retry succeeds');
    });

    it('isolates one failure from the rest of the batch', async () => {
      const user = await loginAs(app, '+919876590006');
      await reserve(user.authHeader);
      await reserve(user.authHeader, 'DRIVER_DOCUMENT');
      await reserve(user.authHeader, 'VEHICLE_IMAGE');
      provider.failNext('delete', true);

      const result = await sweeper.run(afterUploadWindow());

      assert.equal(result.scanned, 3);
      assert.equal(result.reclaimed, 2);
      assert.equal(result.failed, 1);
    });

    it('refuses to run twice at once, and frees the lock afterwards', async () => {
      const redis = container.resolve<{
        lock: { acquire: (r: string, ms: number) => Promise<string | null> };
      }>('redisService');
      const held = await redis.lock.acquire('file:sweeper', 5000);
      assert.ok(held);

      const blocked = await sweeper.run(afterUploadWindow());

      assert.equal(blocked.ran, false);
    });

    it('releases its own lock so the next run proceeds', async () => {
      assert.equal((await sweeper.run(afterUploadWindow())).ran, true);
      assert.equal((await sweeper.run(afterUploadWindow())).ran, true);
    });
  });

  describe('retention', () => {
    function afterWindow(purpose: 'PROFILE_IMAGE' | 'DRIVER_DOCUMENT'): Date {
      return new Date(Date.now() + (fileConfig.purposes[purpose].retention.afterDays + 1) * DAY_MS);
    }

    function claim(purpose: 'PROFILE_IMAGE' | 'DRIVER_DOCUMENT', referenced = false): void {
      registerFileReference(purpose, {
        module: purpose === 'PROFILE_IMAGE' ? 'users' : 'documents',
        isReferenced: async () => referenced,
      });
    }

    async function closed(
      auth: { authorization: string },
      purpose: 'PROFILE_IMAGE' | 'DRIVER_DOCUMENT' = 'PROFILE_IMAGE',
    ): Promise<{ fileId: string; storageKey: string }> {
      const file = await publish(auth, purpose);
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/files/${file.fileId}`,
        headers: auth,
      });
      assert.equal(response.statusCode, 204);
      return file;
    }

    it('leaves a purpose no module has claimed entirely alone', async () => {
      const user = await loginAs(app, '+919876590010');
      const { fileId, storageKey } = await closed(user.authHeader);

      const result = await retention.run(afterWindow('PROFILE_IMAGE'));

      assert.equal(result.unclaimed, 1);
      assert.equal(result.erased, 0);
      const row = await db().client.file.findUniqueOrThrow({ where: { id: fileId } });
      assert.equal(row.erasedAt, null);
      assert.equal(provider.versionIds(storageKey).length > 0, true);
    });

    it('erases a due file whose module has released it', async () => {
      const user = await loginAs(app, '+919876590011');
      const { fileId, storageKey } = await closed(user.authHeader);
      claim('PROFILE_IMAGE');

      const result = await retention.run(afterWindow('PROFILE_IMAGE'));

      assert.equal(result.erased, 1);
      const row = await db().client.file.findUniqueOrThrow({ where: { id: fileId } });
      assert.notEqual(row.erasedAt, null);
      assert.equal(row.archivedAt, null, 'never both (FILE-INV-9)');

      assert.deepEqual(provider.versionIds(storageKey), []);
    });

    it('archives rather than shreds where compliance requires it', async () => {
      const user = await loginAs(app, '+919876590012');
      const { fileId, storageKey } = await closed(user.authHeader, 'DRIVER_DOCUMENT');
      claim('DRIVER_DOCUMENT');

      const result = await retention.run(afterWindow('DRIVER_DOCUMENT'));

      assert.equal(result.archived, 1);
      const row = await db().client.file.findUniqueOrThrow({ where: { id: fileId } });
      assert.notEqual(row.archivedAt, null);

      assert.equal(row.erasedAt, null);
      assert.equal(provider.isArchived(storageKey), true);
      assert.ok(provider.versionIds(storageKey).length > 0, 'the bytes survive');
    });

    it('refuses while a live domain row still references the file', async () => {
      const user = await loginAs(app, '+919876590013');
      const { fileId, storageKey } = await closed(user.authHeader);
      claim('PROFILE_IMAGE', true);

      const result = await retention.run(afterWindow('PROFILE_IMAGE'));

      assert.equal(result.blocked, 1);
      assert.equal(result.erased, 0);
      const row = await db().client.file.findUniqueOrThrow({ where: { id: fileId } });
      assert.equal(row.erasedAt, null);
      assert.ok(provider.versionIds(storageKey).length > 0);
    });

    it('leaves a file whose window has not closed', async () => {
      const user = await loginAs(app, '+919876590014');
      const { fileId } = await closed(user.authHeader);
      claim('PROFILE_IMAGE');

      const result = await retention.run(new Date());

      assert.equal(result.scanned, 0);
      assert.equal(
        (await db().client.file.findUniqueOrThrow({ where: { id: fileId } })).erasedAt,
        null,
      );
    });

    it('starts a superseded file’s clock at supersession, not at upload', async () => {
      const user = await loginAs(app, '+919876590015');
      const previous = await publish(user.authHeader, 'DRIVER_DOCUMENT');
      const replacement = await publish(user.authHeader, 'DRIVER_DOCUMENT');
      await db().client.file.update({
        where: { id: previous.fileId },
        data: { status: 'SUPERSEDED', supersededById: replacement.fileId },
      });
      claim('DRIVER_DOCUMENT');

      const result = await retention.run(afterWindow('DRIVER_DOCUMENT'));

      assert.equal(result.archived, 1);
      assert.notEqual(
        (await db().client.file.findUniqueOrThrow({ where: { id: previous.fileId } })).archivedAt,
        null,
      );
    });

    it('never re-processes a file that already has a terminal outcome', async () => {
      const user = await loginAs(app, '+919876590016');
      const { fileId } = await closed(user.authHeader, 'DRIVER_DOCUMENT');
      claim('DRIVER_DOCUMENT');
      await retention.run(afterWindow('DRIVER_DOCUMENT'));
      const first = await db().client.file.findUniqueOrThrow({ where: { id: fileId } });

      const second = await retention.run(afterWindow('DRIVER_DOCUMENT'));

      assert.equal(second.scanned, 0);
      const after = await db().client.file.findUniqueOrThrow({ where: { id: fileId } });
      assert.deepEqual([after.archivedAt, after.erasedAt], [first.archivedAt, null]);
    });
  });

  describe('the file.erased event', () => {
    async function erasedEvents() {
      return db().client.outboxEvent.findMany({ where: { eventType: 'file.erased' } });
    }

    it('distinguishes ARCHIVED from ERASED', async () => {
      const user = await loginAs(app, '+919876590020');
      const avatar = await publish(user.authHeader, 'PROFILE_IMAGE');
      const licence = await publish(user.authHeader, 'DRIVER_DOCUMENT');
      for (const file of [avatar, licence]) {
        await app.inject({
          method: 'DELETE',
          url: `/api/v1/files/${file.fileId}`,
          headers: user.authHeader,
        });
      }
      registerFileReference('PROFILE_IMAGE', { module: 'users', isReferenced: async () => false });
      registerFileReference('DRIVER_DOCUMENT', {
        module: 'documents',
        isReferenced: async () => false,
      });

      await retention.run(new Date(Date.now() + 3000 * DAY_MS));

      const byFile = new Map(
        (await erasedEvents()).map((event) => [
          event.aggregateId,
          (event.payload as { data: { action: string } }).data.action,
        ]),
      );

      assert.equal(byFile.get(avatar.fileId), 'ERASED');
      assert.equal(byFile.get(licence.fileId), 'ARCHIVED');
    });

    it('names no owner — the point is that the subject’s data is gone', async () => {
      const user = await loginAs(app, '+919876590021');
      const file = await publish(user.authHeader);
      await app.inject({
        method: 'DELETE',
        url: `/api/v1/files/${file.fileId}`,
        headers: user.authHeader,
      });
      registerFileReference('PROFILE_IMAGE', { module: 'users', isReferenced: async () => false });

      await retention.run(new Date(Date.now() + 400 * DAY_MS));

      const [event] = await erasedEvents();
      const serialized = JSON.stringify(event?.payload);

      assert.equal(serialized.includes(user.userId), false);
      assert.equal(serialized.includes(file.storageKey), false);
      assert.deepEqual((event?.payload as { data: Record<string, unknown> }).data, {
        fileId: file.fileId,
        purpose: 'PROFILE_IMAGE',
        action: 'ERASED',
        retentionRule: 'REPLACED',
      });
    });
  });

  describe('when retention keeps failing', () => {
    it('retries, then dead-letters with the last error', async () => {
      const user = await loginAs(app, '+919876590030');
      const file = await publish(user.authHeader);
      await app.inject({
        method: 'DELETE',
        url: `/api/v1/files/${file.fileId}`,
        headers: user.authHeader,
      });
      registerFileReference('PROFILE_IMAGE', { module: 'users', isReferenced: async () => false });
      const due = new Date(Date.now() + 400 * DAY_MS);

      for (let attempt = 0; attempt < fileConfig.jobMaxAttempts; attempt += 1) {
        provider.failNext('erase', true);
        assert.equal((await retention.run(due)).failed, 1);
        assert.equal(await retention.deadLettered().then((d) => d.length), attempt === 4 ? 1 : 0);
      }

      const [entry] = await retention.deadLettered();
      assert.equal(entry?.fileId, file.fileId);
      assert.equal(entry?.attempts, fileConfig.jobMaxAttempts);
      assert.ok(entry?.error, 'carries the last error for the runbook');
      assert.equal(entry?.error.includes(file.storageKey), false, 'and no key');
    });

    it('forgets the attempt count once the file finally succeeds', async () => {
      const user = await loginAs(app, '+919876590031');
      const file = await publish(user.authHeader);
      await app.inject({
        method: 'DELETE',
        url: `/api/v1/files/${file.fileId}`,
        headers: user.authHeader,
      });
      registerFileReference('PROFILE_IMAGE', { module: 'users', isReferenced: async () => false });
      const due = new Date(Date.now() + 400 * DAY_MS);

      provider.failNext('erase', true);
      await retention.run(due);
      await retention.run(due);

      assert.deepEqual(await retention.deadLettered(), []);
      assert.notEqual(
        (await db().client.file.findUniqueOrThrow({ where: { id: file.fileId } })).erasedAt,
        null,
      );
    });
  });
});

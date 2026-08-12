import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { container } from '../../src/core/di.js';
import { png as image } from '../helpers/image-fixtures.js';
import type { FileRetentionJob } from '../../src/modules/files/jobs/retention.job.js';
import type { MockStorageProvider } from '../../src/modules/files/providers/mock.provider.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function png(): Buffer {
  return image({ width: 800, height: 600 });
}

describe('profile image cutover (integration)', () => {
  let app: FastifyInstance;
  let provider: MockStorageProvider;
  let retention: FileRetentionJob;

  before(async () => {
    app = await bootApp();
    provider = container.resolve<MockStorageProvider>('storageProvider');
    retention = container.resolve<FileRetentionJob>('fileRetentionJob');
  });
  after(async () => {
    await app.close();
  });
  afterEach(async () => {
    await resetState();
    provider.reset();
  });

  async function uploadAvatar(
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
    provider.putObject(row.storageKey, png(), 'image/png');
    const completed = await app.inject({
      method: 'POST',
      url: `/api/v1/files/${fileId}/complete`,
      headers: auth,
    });
    assert.equal(completed.statusCode, 200, completed.payload);
    return { fileId, storageKey: row.storageKey };
  }

  function setAvatar(auth: { authorization: string }, fileId: string | null) {
    return app.inject({
      method: 'PATCH',
      url: '/api/v1/users/me/profile',
      headers: auth,
      payload: { profileImageFileId: fileId },
    });
  }

  function getMe(auth: { authorization: string }) {
    return app.inject({ method: 'GET', url: '/api/v1/users/me', headers: auth });
  }

  describe('setting an avatar', () => {
    it('stores a file id, and the profile reads it back', async () => {
      const user = await loginAs(app, '+919876610001');
      const { fileId } = await uploadAvatar(user.authHeader);

      const patched = await setAvatar(user.authHeader, fileId);

      assert.equal(patched.statusCode, 200, patched.payload);
      assert.equal(patched.json().profileImageFileId, fileId);
      assert.equal((await getMe(user.authHeader)).json().profile.profileImageFileId, fileId);
    });

    it('stores no URL anywhere — the response carries an id and nothing else', async () => {
      const user = await loginAs(app, '+919876610002');
      const { fileId, storageKey } = await uploadAvatar(user.authHeader);
      await setAvatar(user.authHeader, fileId);

      const body = (await getMe(user.authHeader)).payload;
      const columns = await db().client.$queryRaw<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'user_profiles'`;

      assert.equal(
        columns.some((column) => column.column_name === 'profile_image'),
        false,
        'the URL column is gone, not merely unused',
      );
      assert.equal(body.includes('http'), false);
      assert.equal(body.includes(storageKey), false);
    });

    it('mints a working read URL from the id it returned', async () => {
      const user = await loginAs(app, '+919876610003');
      const { fileId } = await uploadAvatar(user.authHeader);
      await setAvatar(user.authHeader, fileId);

      const minted = await app.inject({
        method: 'GET',
        url: `/api/v1/files/${fileId}/url`,
        headers: user.authHeader,
      });

      assert.equal(minted.statusCode, 200);
      assert.equal(provider.verifyUrl(minted.json().url as string, { method: 'GET' }).ok, true);
    });

    it('refuses a file whose bytes were never verified (FILE-INV-3)', async () => {
      const user = await loginAs(app, '+919876610010');
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/files',
        headers: { ...user.authHeader, 'idempotency-key': randomUUID() },
        payload: {
          purpose: 'PROFILE_IMAGE',
          fileName: 'me.png',
          contentType: 'image/png',
          sizeBytes: 2048,
        },
      });

      const patched = await setAvatar(user.authHeader, created.json().fileId as string);

      assert.equal(patched.statusCode, 409);
      assert.equal(patched.json().error.code, 'CONFLICT');
    });

    it('refuses another user’s file, indistinguishably from a missing one', async () => {
      const owner = await loginAs(app, '+919876610011');
      const stranger = await loginAs(app, '+919876610012');
      const { fileId } = await uploadAvatar(owner.authHeader);

      const stolen = await setAvatar(stranger.authHeader, fileId);
      const absent = await setAvatar(stranger.authHeader, randomUUID());

      assert.equal(stolen.statusCode, 404);
      assert.deepEqual(
        { ...stolen.json().error, requestId: null },
        { ...absent.json().error, requestId: null },
      );
    });

    it('refuses a file of the wrong purpose', async () => {
      const user = await loginAs(app, '+919876610013');
      const { fileId } = await uploadAvatar(user.authHeader, 'DRIVER_DOCUMENT');

      const patched = await setAvatar(user.authHeader, fileId);

      assert.equal(patched.statusCode, 404);
    });

    it('leaves the profile untouched when the attach is refused', async () => {
      const user = await loginAs(app, '+919876610014');
      const { fileId } = await uploadAvatar(user.authHeader);
      await setAvatar(user.authHeader, fileId);

      const refused = await app.inject({
        method: 'PATCH',
        url: '/api/v1/users/me/profile',
        headers: user.authHeader,
        payload: { firstName: 'Aarav', profileImageFileId: randomUUID() },
      });

      assert.equal(refused.statusCode, 404);
      const profile = (await getMe(user.authHeader)).json().profile;
      assert.equal(profile.profileImageFileId, fileId);
      assert.equal(profile.firstName, null);
    });
  });

  describe('replacing an avatar', () => {
    it('supersedes the previous one rather than deleting it', async () => {
      const user = await loginAs(app, '+919876610020');
      const first = await uploadAvatar(user.authHeader);
      await setAvatar(user.authHeader, first.fileId);
      const second = await uploadAvatar(user.authHeader);

      const patched = await setAvatar(user.authHeader, second.fileId);

      assert.equal(patched.statusCode, 200, patched.payload);
      const previous = await db().client.file.findUniqueOrThrow({ where: { id: first.fileId } });

      assert.equal(previous.status, 'SUPERSEDED');
      assert.equal(previous.supersededById, second.fileId);
      assert.equal(previous.deletedAt, null);
    });

    it('is the flow the dropped index made impossible', async () => {
      const user = await loginAs(app, '+919876610021');
      const first = await uploadAvatar(user.authHeader);
      await setAvatar(user.authHeader, first.fileId);

      const second = await uploadAvatar(user.authHeader);
      await setAvatar(user.authHeader, second.fileId);
      const third = await uploadAvatar(user.authHeader);
      await setAvatar(user.authHeader, third.fileId);

      const chain = await db().client.file.findMany({
        where: { ownerUserId: user.userId },
        orderBy: { createdAt: 'asc' },
      });
      assert.deepEqual(
        chain.map((file) => file.status),
        ['SUPERSEDED', 'SUPERSEDED', 'READY'],
      );
      assert.equal((await getMe(user.authHeader)).json().profile.profileImageFileId, third.fileId);
    });

    it('takes the old avatar out of the read path immediately', async () => {
      const user = await loginAs(app, '+919876610022');
      const first = await uploadAvatar(user.authHeader);
      await setAvatar(user.authHeader, first.fileId);
      const second = await uploadAvatar(user.authHeader);
      await setAvatar(user.authHeader, second.fileId);

      const stale = await app.inject({
        method: 'GET',
        url: `/api/v1/files/${first.fileId}/url`,
        headers: user.authHeader,
      });

      assert.equal(stale.statusCode, 404);
    });

    it('emits file.superseded in the profile’s own transaction', async () => {
      const user = await loginAs(app, '+919876610023');
      const first = await uploadAvatar(user.authHeader);
      await setAvatar(user.authHeader, first.fileId);
      const second = await uploadAvatar(user.authHeader);
      await setAvatar(user.authHeader, second.fileId);

      const events = await db().client.outboxEvent.findMany({
        where: { eventType: { in: ['file.superseded', 'user.profile.updated'] } },
      });

      assert.equal(events.filter((e) => e.eventType === 'file.superseded').length, 1);
      assert.ok(events.some((e) => e.eventType === 'user.profile.updated'));
    });

    it('treats re-submitting the same id as a no-op, not a conflict', async () => {
      const user = await loginAs(app, '+919876610024');
      const { fileId } = await uploadAvatar(user.authHeader);
      await setAvatar(user.authHeader, fileId);

      const again = await setAvatar(user.authHeader, fileId);

      assert.equal(again.statusCode, 200, again.payload);
      const file = await db().client.file.findUniqueOrThrow({ where: { id: fileId } });
      assert.equal(file.status, 'READY');
    });

    it('clears the avatar and releases the file rather than superseding it', async () => {
      const user = await loginAs(app, '+919876610025');
      const { fileId } = await uploadAvatar(user.authHeader);
      await setAvatar(user.authHeader, fileId);

      const cleared = await setAvatar(user.authHeader, null);

      assert.equal(cleared.statusCode, 200);
      assert.equal(cleared.json().profileImageFileId, null);
      const file = await db().client.file.findUniqueOrThrow({ where: { id: fileId } });
      assert.equal(file.status, 'DELETED');
      assert.ok(file.deletedAt, 'and dated, which is what retention selects on');
      assert.equal(file.supersededById, null, 'nothing replaced it');
    });

    it('makes a cleared avatar collectable by the retention job', async () => {
      const user = await loginAs(app, '+919876610026');
      const { fileId, storageKey } = await uploadAvatar(user.authHeader);
      await setAvatar(user.authHeader, fileId);
      await setAvatar(user.authHeader, null);

      const result = await retention.run(new Date(Date.now() + 400 * DAY_MS));

      assert.equal(result.erased + result.archived, 1, JSON.stringify(result));
      assert.deepEqual(provider.versionIds(storageKey), [], 'the object is gone from storage');
    });

    it('releases the file in the same transaction as the profile update', async () => {
      const user = await loginAs(app, '+919876610027');
      const { fileId } = await uploadAvatar(user.authHeader);
      await setAvatar(user.authHeader, fileId);

      await setAvatar(user.authHeader, null);

      const profile = await db().client.userProfile.findUniqueOrThrow({
        where: { userId: user.userId },
      });
      const file = await db().client.file.findUniqueOrThrow({ where: { id: fileId } });
      assert.equal(profile.profileImageFileId, null);
      assert.equal(file.status, 'DELETED');
    });

    it('is idempotent — clearing an already-empty avatar changes nothing', async () => {
      const user = await loginAs(app, '+919876610028');

      const first = await setAvatar(user.authHeader, null);
      const second = await setAvatar(user.authHeader, null);

      assert.equal(first.statusCode, 200);
      assert.equal(second.statusCode, 200, second.payload);
      assert.equal(second.json().profileImageFileId, null);
    });
  });

  describe('with `users` holding the reference', () => {
    it('refuses to delete an avatar somebody is wearing', async () => {
      const user = await loginAs(app, '+919876610030');
      const { fileId } = await uploadAvatar(user.authHeader);
      await setAvatar(user.authHeader, fileId);

      const deleted = await app.inject({
        method: 'DELETE',
        url: `/api/v1/files/${fileId}`,
        headers: user.authHeader,
      });

      assert.equal(deleted.statusCode, 409);
      assert.equal(deleted.json().error.code, 'FILE_IN_USE');
      assert.equal(deleted.json().error.module, 'users');
    });

    it('allows the delete once the profile lets go', async () => {
      const user = await loginAs(app, '+919876610031');
      const { fileId } = await uploadAvatar(user.authHeader);
      await setAvatar(user.authHeader, fileId);
      await setAvatar(user.authHeader, null);

      const deleted = await app.inject({
        method: 'DELETE',
        url: `/api/v1/files/${fileId}`,
        headers: user.authHeader,
      });

      assert.equal(deleted.statusCode, 204);
    });

    it('lets retention erase a superseded avatar, and refuses a current one', async () => {
      const user = await loginAs(app, '+919876610032');
      const first = await uploadAvatar(user.authHeader);
      await setAvatar(user.authHeader, first.fileId);
      const second = await uploadAvatar(user.authHeader);
      await setAvatar(user.authHeader, second.fileId);

      const result = await retention.run(new Date(Date.now() + 400 * DAY_MS));

      assert.equal(result.erased, 1);
      assert.deepEqual(provider.versionIds(first.storageKey), []);
      assert.ok(provider.versionIds(second.storageKey).length > 0, 'the current avatar survives');
    });
  });
});

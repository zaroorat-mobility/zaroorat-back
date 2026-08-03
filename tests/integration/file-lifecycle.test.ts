import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { container } from '../../src/core/di.js';
import {
  clearFileReferences,
  registerFileReference,
} from '../../src/modules/files/file-references.js';
import type { MockStorageProvider } from '../../src/modules/files/providers/mock.provider.js';

/** A valid 800x600 PNG header — enough for the magic-byte and dimension gates. */
function png(): Buffer {
  const header = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(800, 16);
  header.writeUInt32BE(600, 20);
  return header;
}

/**
 * Soft delete (files doc 02 §2.5, doc 06 §3 #9, FILE-INV-5).
 *
 * The claim under test is a two-part one and the parts pull in opposite
 * directions: a deleted file must vanish from every read path **immediately**,
 * and its bytes must **survive** until the retention job's window closes
 * (R-FILE-18). A test that only checked the first half would pass against an
 * implementation that erased inline and destroyed evidence at the moment a user
 * asked for it to disappear.
 */
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

  /** Upload and complete, returning the file id and its storage key. */
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

  /** Every `file.deleted` in the outbox, newest last. */
  async function deletedEvents() {
    return db().client.outboxEvent.findMany({
      where: { eventType: 'file.deleted' },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ── The row leaves the read path, the bytes do not ────────────────────────

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

      // Doc 04 §4 case 3: the owner's own soft-deleted file is a `404`, the same
      // one a nonexistent id produces.
      assert.equal(url.statusCode, 404);
      assert.equal(metadata.statusCode, 404);
      assert.equal(url.json().error.code, 'NOT_FOUND');
    });

    it('leaves the object in storage, unerased (criterion #9)', async () => {
      const user = await loginAs(app, '+919876570003');
      const { fileId, storageKey } = await publish(user.authHeader);

      await remove(user.authHeader, fileId);

      // R-FILE-18: erasure is the retention job's and never inline. Destroying
      // the bytes here would take out the evidence a later dispute needs, at
      // exactly the moment somebody asked for it to disappear.
      assert.notEqual(await provider.head(storageKey, 8), null, 'the object survives');
      const row = await db().client.file.findUniqueOrThrow({ where: { id: fileId } });
      assert.equal(row.erasedAt, null);
      assert.equal(row.archivedAt, null);
    });

    it('stops counting the bytes against the user’s quota', async () => {
      const user = await loginAs(app, '+919876570004');
      const { fileId } = await publish(user.authHeader);

      await remove(user.authHeader, fileId);

      // Doc 08 §5: the bytes survive until retention, but charging a user for
      // storage they asked to delete is indefensible.
      const live = await db().client.file.aggregate({
        where: { ownerUserId: user.userId, deletedAt: null, status: { in: ['PENDING', 'READY'] } },
        _sum: { sizeBytes: true },
      });
      assert.equal(live._sum.sizeBytes, null);
    });
  });

  // ── Idempotency and refusals ──────────────────────────────────────────────

  describe('repeating or misdirecting a delete', () => {
    it('answers 204 again, and emits exactly one event', async () => {
      const user = await loginAs(app, '+919876570010');
      const { fileId } = await publish(user.authHeader);

      assert.equal((await remove(user.authHeader, fileId)).statusCode, 204);
      assert.equal((await remove(user.authHeader, fileId)).statusCode, 204);

      // A converged repeat succeeded (doc 02 §2.5) — but two `file.deleted`
      // records would make one deletion look like two in the audit trail, which
      // is the one place that must not be approximate.
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

      // Doc 01 §7: only `READY → DELETED` is a defined transition. A reservation
      // is reclaimed by the sweeper, not deleted by its owner.
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

      // R-FILE-32: the previous version was valid evidence for the period it was
      // current, and is retained for the purpose's full window. Letting its
      // owner delete it would give a driver a way to erase the licence they were
      // operating under.
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

  // ── FILE-INV-5: a referenced file cannot be deleted ───────────────────────

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

      // Doc 04 §2.2: `details.module` tells the client where to detach it. The
      // row, its id, and the key are all internal coordinates (§5).
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

  // ── The one-live-avatar rule (doc 03 §4.4) ────────────────────────────────

  describe('a second live profile image', () => {
    /** Reserve, PUT, and attempt completion — returning the completion reply. */
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

      // Until the phase-7 cutover this was a refusal, and the refusal made
      // avatar replacement impossible: `uq_files_one_live_profile_image` would
      // not let the new file become READY while the old one was, and
      // `supersede` will not accept a replacement that is not READY. Neither
      // could go first. The index was dropped in favour of R-FILE-31; which
      // avatar is *current* is now `user_profiles.profile_image_file_id`.
      assert.equal(completed.statusCode, 200, completed.payload);
      assert.equal(completed.json().status, 'READY');
    });

    it('leaves the previous one READY until something attaches the new one', async () => {
      const user = await loginAs(app, '+919876570041');
      const { fileId: firstId } = await publish(user.authHeader);
      const { fileId: secondId } = await attempt(user.authHeader);

      // Supersession is the attaching module's, in its own transaction
      // (R-FILE-27) — `files` never demotes a version on its own, because it
      // cannot know that anything took the new one up.
      const first = await db().client.file.findUniqueOrThrow({ where: { id: firstId } });
      const second = await db().client.file.findUniqueOrThrow({ where: { id: secondId } });
      assert.equal(first.status, 'READY');
      assert.equal(first.supersededById, null);
      assert.equal(second.status, 'READY');
    });
  });

  // ── The audit record (doc 05 §3.3) ────────────────────────────────────────

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

      // `fileName` is the field a reader would most expect and the one most
      // likely to carry a personal value — `aadhaar-ayesha-1998.jpg` in an event
      // stream is a leak no downstream care undoes.
      assert.equal(serialized.includes(storageKey), false);
      assert.equal(serialized.includes('me.png'), false);
      assert.equal(serialized.includes('X-Mock-Signature'), false);
    });
  });
});

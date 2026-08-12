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
import type { TransactionManager } from '../../src/core/database/TransactionManager.js';
import type { FileService } from '../../src/modules/files/services/file.service.js';
import type { MockStorageProvider } from '../../src/modules/files/providers/mock.provider.js';

function png(): Buffer {
  return image({ width: 800, height: 600 });
}

describe('file supersession (integration)', () => {
  let app: FastifyInstance;
  let provider: MockStorageProvider;
  let fileService: FileService;
  let transactionManager: TransactionManager;

  before(async () => {
    app = await bootApp();
    provider = container.resolve<MockStorageProvider>('storageProvider');
    fileService = container.resolve<FileService>('fileService');
    transactionManager = container.resolve<TransactionManager>('transactionManager');
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
    purpose = 'DRIVER_DOCUMENT',
  ): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/files',
      headers: { ...auth, 'idempotency-key': randomUUID() },
      payload: { purpose, fileName: 'licence.png', contentType: 'image/png', sizeBytes: 2048 },
    });
    assert.equal(created.statusCode, 201, created.payload);
    return created.json().fileId as string;
  }

  async function publish(
    auth: { authorization: string },
    purpose = 'DRIVER_DOCUMENT',
  ): Promise<string> {
    const fileId = await reserve(auth, purpose);
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

  function supersede(previousId: string, replacementId: string): Promise<void> {
    return transactionManager.execute((tx) => fileService.supersede(previousId, replacementId, tx));
  }

  async function supersededEvents() {
    return db().client.outboxEvent.findMany({ where: { eventType: 'file.superseded' } });
  }

  describe('replacing a file', () => {
    it('marks the previous version SUPERSEDED and names its successor', async () => {
      const user = await loginAs(app, '+919876580001');
      const previousId = await publish(user.authHeader);
      const replacementId = await publish(user.authHeader);

      await supersede(previousId, replacementId);

      const previous = await db().client.file.findUniqueOrThrow({ where: { id: previousId } });
      assert.equal(previous.status, 'SUPERSEDED');
      assert.equal(previous.supersededById, replacementId);

      assert.equal(previous.deletedAt, null);
      assert.equal(previous.erasedAt, null);
    });

    it('leaves the replacement current and the previous unreadable', async () => {
      const user = await loginAs(app, '+919876580002');
      const previousId = await publish(user.authHeader);
      const replacementId = await publish(user.authHeader);
      await supersede(previousId, replacementId);

      const stale = await app.inject({
        method: 'GET',
        url: `/api/v1/files/${previousId}/url`,
        headers: user.authHeader,
      });
      const current = await app.inject({
        method: 'GET',
        url: `/api/v1/files/${replacementId}/url`,
        headers: user.authHeader,
      });

      assert.equal(stale.statusCode, 404);
      assert.equal(current.statusCode, 200);
    });

    it('emits file.superseded, distinct from file.deleted', async () => {
      const user = await loginAs(app, '+919876580003');
      const previousId = await publish(user.authHeader);
      const replacementId = await publish(user.authHeader);

      await supersede(previousId, replacementId);

      const [event] = await supersededEvents();
      assert.ok(event, 'the audit record exists');
      const payload = event.payload as { data: Record<string, unknown> };

      assert.deepEqual(payload.data, {
        fileId: previousId,
        replacementFileId: replacementId,
        ownerUserId: user.userId,
        purpose: 'DRIVER_DOCUMENT',
      });
      assert.equal(
        await db().client.outboxEvent.count({ where: { eventType: 'file.deleted' } }),
        0,
      );
    });

    it('commits with the attaching module’s transaction, or not at all', async () => {
      const user = await loginAs(app, '+919876580004');
      const previousId = await publish(user.authHeader);
      const replacementId = await publish(user.authHeader);

      await assert.rejects(() =>
        transactionManager.execute(async (tx) => {
          await fileService.supersede(previousId, replacementId, tx);

          throw new Error('the attach failed');
        }),
      );

      const previous = await db().client.file.findUniqueOrThrow({ where: { id: previousId } });
      assert.equal(previous.status, 'READY');
      assert.equal(previous.supersededById, null);
      assert.equal((await supersededEvents()).length, 0);
    });
  });

  describe('refusals', () => {
    it('refuses a replacement belonging to a different owner', async () => {
      const owner = await loginAs(app, '+919876580010');
      const other = await loginAs(app, '+919876580011');
      const previousId = await publish(owner.authHeader);
      const replacementId = await publish(other.authHeader);

      await assert.rejects(() => supersede(previousId, replacementId), /same owner/);
    });

    it('refuses a replacement of a different purpose', async () => {
      const user = await loginAs(app, '+919876580012');
      const previousId = await publish(user.authHeader, 'DRIVER_DOCUMENT');
      const replacementId = await publish(user.authHeader, 'VEHICLE_DOCUMENT');

      await assert.rejects(() => supersede(previousId, replacementId), /same.*purpose|purpose/);
    });

    it('refuses a replacement whose bytes were never verified (FILE-INV-3)', async () => {
      const user = await loginAs(app, '+919876580013');
      const previousId = await publish(user.authHeader);
      const pendingId = await reserve(user.authHeader);

      await assert.rejects(() => supersede(previousId, pendingId), /not available to attach/);
      const previous = await db().client.file.findUniqueOrThrow({ where: { id: previousId } });
      assert.equal(previous.status, 'READY');
    });

    it('refuses to fork a chain that is already superseded', async () => {
      const user = await loginAs(app, '+919876580014');
      const previousId = await publish(user.authHeader);
      const firstReplacement = await publish(user.authHeader);
      const secondReplacement = await publish(user.authHeader);
      await supersede(previousId, firstReplacement);

      await assert.rejects(
        () => supersede(previousId, secondReplacement),
        /no longer the current version/,
      );
    });

    it('refuses a file superseding itself', async () => {
      const user = await loginAs(app, '+919876580015');
      const fileId = await publish(user.authHeader);

      await assert.rejects(() => supersede(fileId, fileId), /cannot supersede itself/);
    });

    it('refuses an id that never existed', async () => {
      const user = await loginAs(app, '+919876580016');
      const replacementId = await publish(user.authHeader);

      await assert.rejects(() => supersede(randomUUID(), replacementId), /No such file/);
    });
  });

  describe('two replacements racing', () => {
    it('yields exactly one chain head', async () => {
      const user = await loginAs(app, '+919876580020');
      const previousId = await publish(user.authHeader);
      const first = await publish(user.authHeader);
      const second = await publish(user.authHeader);

      const outcomes = await Promise.allSettled([
        supersede(previousId, first),
        supersede(previousId, second),
      ]);

      assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1);
      const previous = await db().client.file.findUniqueOrThrow({ where: { id: previousId } });
      assert.equal(previous.status, 'SUPERSEDED');
      assert.ok([first, second].includes(previous.supersededById ?? ''));
      assert.equal((await supersededEvents()).length, 1, 'exactly one audit record');
    });

    it('is backstopped by the database when the application forgets', async () => {
      const user = await loginAs(app, '+919876580021');
      const firstPrevious = await publish(user.authHeader);
      const secondPrevious = await publish(user.authHeader);
      const shared = await publish(user.authHeader);
      await supersede(firstPrevious, shared);

      await assert.rejects(
        () =>
          db().client.$executeRawUnsafe(
            `UPDATE files SET status = 'SUPERSEDED', superseded_by_id = $1::uuid WHERE id = $2::uuid`,
            shared,
            secondPrevious,
          ),
        /files_superseded_by_id_key/,
      );
    });
  });

  describe('assertReferenceable', () => {
    function check(fileId: string, ownerUserId: string, purpose = 'DRIVER_DOCUMENT') {
      return transactionManager.execute((tx) =>
        fileService.assertReferenceable(fileId, ownerUserId, purpose as never, tx),
      );
    }

    it('accepts a READY file of the expected purpose, owned by that user', async () => {
      const user = await loginAs(app, '+919876580030');
      const fileId = await publish(user.authHeader);

      await assert.doesNotReject(() => check(fileId, user.userId));
    });

    it('refuses a PENDING id — bytes that were never verified', async () => {
      const user = await loginAs(app, '+919876580031');
      const fileId = await reserve(user.authHeader);

      await assert.rejects(() => check(fileId, user.userId), /not available to attach/);
    });

    it('refuses a file owned by somebody else', async () => {
      const owner = await loginAs(app, '+919876580032');
      const other = await loginAs(app, '+919876580033');
      const fileId = await publish(owner.authHeader);

      await assert.rejects(() => check(fileId, other.userId), /No such file/);
    });

    it('refuses a file of a different purpose', async () => {
      const user = await loginAs(app, '+919876580034');
      const fileId = await publish(user.authHeader, 'VEHICLE_DOCUMENT');

      await assert.rejects(() => check(fileId, user.userId, 'DRIVER_DOCUMENT'), /No such file/);
    });

    it('refuses a soft-deleted file', async () => {
      const user = await loginAs(app, '+919876580035');
      const fileId = await publish(user.authHeader);
      await db().client.file.update({
        where: { id: fileId },
        data: { status: 'DELETED', deletedAt: new Date() },
      });

      await assert.rejects(() => check(fileId, user.userId), /not available to attach/);
    });

    it('refuses a SUPERSEDED file — the 03 §4A.2 race', async () => {
      const user = await loginAs(app, '+919876580036');
      const previousId = await publish(user.authHeader);
      const replacementId = await publish(user.authHeader);
      await supersede(previousId, replacementId);

      await assert.rejects(() => check(previousId, user.userId), /not available to attach/);
      await assert.doesNotReject(() => check(replacementId, user.userId));
    });

    it('refuses a file another live row already references (R-FILE-33)', async () => {
      const user = await loginAs(app, '+919876580037');
      const fileId = await publish(user.authHeader);
      registerFileReference('DRIVER_DOCUMENT', {
        module: 'documents',
        isReferenced: async (id) => id === fileId,
      });

      await assert.rejects(() => check(fileId, user.userId), /still attached/);
    });

    it('sees the caller’s uncommitted writes', async () => {
      const user = await loginAs(app, '+919876580038');
      const fileId = await publish(user.authHeader);

      await assert.rejects(() =>
        transactionManager.execute(async (tx) => {
          await tx.file.update({
            where: { id: fileId },
            data: { status: 'DELETED', deletedAt: new Date() },
          });

          await fileService.assertReferenceable(fileId, user.userId, 'DRIVER_DOCUMENT', tx);
        }),
      );
    });
  });
});

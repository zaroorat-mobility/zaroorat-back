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
} from '../../src/modules/files/file-references.js';
import type { TransactionManager } from '../../src/core/database/TransactionManager.js';
import type { FileService } from '../../src/modules/files/file.service.js';
import type { MockStorageProvider } from '../../src/modules/files/providers/mock.provider.js';

/**
 * A valid 800x600 PNG.
 *
 * Built by the shared fixture rather than by hand: the header alone is no longer
 * enough, because the EXIF walk has to reach `IDAT` before it can conclude that
 * no metadata chunk is present (R-FILE-29).
 */
function png(): Buffer {
  return image({ width: 800, height: 600 });
}

/**
 * Replacement and the reference check (files doc 03 §4A, FLOW §5/§5A).
 *
 * Neither has an HTTP route and neither ever will: they are the module-to-module
 * surface, called by an owning module **inside its own transaction** (R-FILE-27).
 * There is no replace endpoint because replacement is upload + attach +
 * supersede, and the middle step belongs to the module that stores the file id.
 *
 * So these are exercised the way `AccountService.restore()` is in USER — the
 * service, called directly, inside a real transaction.
 */
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

  /** Reserve a PENDING file. */
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

  /** Reserve, PUT, and complete — a READY file. */
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

  /** Run `supersede` the way an attaching module would: in its own transaction. */
  function supersede(previousId: string, replacementId: string): Promise<void> {
    return transactionManager.execute((tx) => fileService.supersede(previousId, replacementId, tx));
  }

  async function supersededEvents() {
    return db().client.outboxEvent.findMany({ where: { eventType: 'file.superseded' } });
  }

  // ── The replacement itself (R-FILE-31) ────────────────────────────────────

  describe('replacing a file', () => {
    it('marks the previous version SUPERSEDED and names its successor', async () => {
      const user = await loginAs(app, '+919876580001');
      const previousId = await publish(user.authHeader);
      const replacementId = await publish(user.authHeader);

      await supersede(previousId, replacementId);

      const previous = await db().client.file.findUniqueOrThrow({ where: { id: previousId } });
      assert.equal(previous.status, 'SUPERSEDED');
      assert.equal(previous.supersededById, replacementId);
      // Not a deletion: R-FILE-32 keeps it for the purpose's full window,
      // measured from here, because it *was* valid evidence.
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

      // Doc 02 §4: a previous licence version is retained as evidence, not
      // served — reading history is an `admin` capability that does not exist.
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
      // Doc 05 §3.4: a consumer that conflated these would eventually read "the
      // driver renewed their licence" as "the driver withdrew it", and those
      // have opposite compliance meanings.
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
          // Whatever the caller was really doing — writing
          // `driver_documents.file_id` and its own event — failed.
          throw new Error('the attach failed');
        }),
      );

      // R-FILE-31: a failed attach leaves the previous version current and
      // announces nothing. If the swap committed and the supersession did not,
      // "which licence is current?" would have two answers.
      const previous = await db().client.file.findUniqueOrThrow({ where: { id: previousId } });
      assert.equal(previous.status, 'READY');
      assert.equal(previous.supersededById, null);
      assert.equal((await supersededEvents()).length, 0);
    });
  });

  // ── What it refuses (03 §4A.1) ────────────────────────────────────────────

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

      // A chain crossing purposes would move a file between read policies and
      // retention classes — what FILE-INV-7 forbids doing to `purpose` directly.
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

      // FILE-INV-8: a version chain is a line, not a tree. Two successors and
      // "which version is current?" stops having one answer.
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

  // ── FILE-INV-8 under concurrency ──────────────────────────────────────────

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

      // Two drivers-side renewals landing together is exactly how a chain
      // becomes a tree. The conditional `WHERE status = 'READY'` is what makes
      // the loser fail rather than overwrite the winner's successor.
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

      // files_superseded_by_id_key (03 §4.5). Raw SQL, because the point is that
      // the guarantee survives an application path that skipped the service.
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

  // ── The reference check (R-FILE-27, FLOW §5) ──────────────────────────────

  describe('assertReferenceable', () => {
    /** Call it the way an attaching module would. */
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

      // FILE-INV-3, and the reason this function exists: without it a client
      // could attach a reservation and produce a KYC record pointing at bytes
      // that never arrived.
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

      // Merged with "no such file" on purpose: a caller guessing ids must not
      // learn what a file it cannot use is for (doc 04 §4).
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

      // driver uploads licence → admin opens review → driver replaces it →
      // admin approves the OLD file. The approval fails loudly here instead of
      // landing on a version nobody is presenting any more.
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

      // FILES-OD-13: at most one live reference. Two would make both the
      // retention guard and FILE_IN_USE ambiguous — "is anyone still using
      // this?" would stop having a yes/no answer.
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
          // R-FILE-27's whole point: a check that ran outside the caller's
          // transaction would be a claim about the past by the time the
          // dependent row landed.
          await fileService.assertReferenceable(fileId, user.userId, 'DRIVER_DOCUMENT', tx);
        }),
      );
    });
  });
});

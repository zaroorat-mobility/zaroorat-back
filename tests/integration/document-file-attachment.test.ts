import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState, type LoggedInUser } from './helpers/harness.js';
import { container } from '../../src/core/di.js';
import { png as image } from '../helpers/image-fixtures.js';
import type { MockStorageProvider } from '../../src/modules/files/utils/storage/mock.provider.js';
import type {
  TransactionClient,
  TransactionManager,
} from '../../src/core/database/TransactionManager.js';
import type { FileService } from '../../src/modules/files/index.js';
import { FileInUseError } from '../../src/modules/files/errors/file.errors.js';

/// One stored file backs at most one document side — the front or the back of one document —
/// however the attaching requests interleave. The races here are made deterministic by
/// holding the first transaction open on a gate while the second one runs.
describe('one file, one document side (concurrency)', () => {
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

  const files = () => container.resolve<FileService>('fileService');
  const txManager = () => container.resolve<TransactionManager>('transactionManager');

  async function uploadFile(user: LoggedInUser): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/files',
      headers: { ...user.authHeader, 'idempotency-key': randomUUID() },
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
    provider.putObject(row.storageKey, image({ width: 400, height: 300 }), 'image/png');
    const completed = await app.inject({
      method: 'POST',
      url: `/api/v1/files/${fileId}/complete`,
      headers: user.authHeader,
    });
    assert.equal(completed.statusCode, 200, completed.payload);
    return fileId;
  }

  async function driver(phone: string) {
    const user = await loginAs(app, phone);
    const me = await app.inject({
      method: 'POST',
      url: '/api/v1/drivers/me/onboard',
      headers: user.authHeader,
    });
    return { user, driverId: me.json().data.id as string };
  }

  const submit = (user: LoggedInUser, driverId: string, body: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/drivers/${driverId}/documents`,
      headers: user.authHeader,
      payload: body,
    });

  const references = (fileId: string) =>
    db().client.driverDocument.count({ where: { OR: [{ fileId }, { backFileId: fileId }] } });

  /// Starts `work` in a transaction that stays open until the returned `release` is called.
  function holdOpen(work: (tx: TransactionClient) => Promise<void>) {
    let release!: () => void;
    let ready!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (ready = resolve));
    const done = txManager().execute(async (tx) => {
      await work(tx);
      ready();
      await gate;
    });
    return { started, release, done };
  }

  /// Whether `promise` is still unsettled after a short wait — i.e. blocked on a row lock.
  async function stillPending(promise: Promise<unknown>): Promise<boolean> {
    const marker = Symbol('pending');
    const outcome = await Promise.race([
      promise.then(
        () => 'settled',
        () => 'settled',
      ),
      new Promise((resolve) => setTimeout(() => resolve(marker), 400)),
    ]);
    return outcome === marker;
  }

  it('makes a second attach of the same file wait for the first, then refuses it', async () => {
    const { user, driverId } = await driver('+919876580001');
    const shared = await uploadFile(user);

    // The first request has checked the file and attached it as a licence front, uncommitted.
    const first = holdOpen(async (tx) => {
      await files().assertReferenceable(shared, user.userId, 'DRIVER_DOCUMENT', tx);
      await tx.driverDocument.create({
        data: { driverId, documentType: 'DRIVING_LICENSE', fileId: shared },
      });
    });
    await first.started;

    // The second request checks the same file to attach it as an Aadhaar back.
    const second = txManager().execute((tx) =>
      files().assertReferenceable(shared, user.userId, 'DRIVER_DOCUMENT', tx),
    );
    const blocked = await stillPending(second);

    first.release();
    await first.done;
    await assert.rejects(second, FileInUseError);
    assert.equal(blocked, true, 'the second check must wait on the first, not race it');
    assert.equal(await references(shared), 1);
  });

  it('lets exactly one of two simultaneous requests attach a file, front or back', async () => {
    const { user, driverId } = await driver('+919876580002');
    const shared = await uploadFile(user);
    const otherFront = await uploadFile(user);

    const results = await Promise.all([
      submit(user, driverId, { documentType: 'AADHAAR', fileId: shared }),
      submit(user, driverId, {
        documentType: 'DRIVING_LICENSE',
        fileId: otherFront,
        backFileId: shared,
      }),
    ]);

    assert.deepEqual(
      results.map((r) => r.statusCode).sort(),
      [201, 409],
      results.map((r) => r.payload).join('\n'),
    );
    assert.equal(await references(shared), 1);
  });

  it('refuses a file already used as another document front as a back, and the reverse', async () => {
    const { user, driverId } = await driver('+919876580003');
    const front = await uploadFile(user);
    const back = await uploadFile(user);
    assert.equal(
      (await submit(user, driverId, { documentType: 'AADHAAR', fileId: front, backFileId: back }))
        .statusCode,
      201,
    );

    const asBack = await submit(user, driverId, {
      documentType: 'DRIVING_LICENSE',
      fileId: await uploadFile(user),
      backFileId: front,
    });
    const asFront = await submit(user, driverId, { documentType: 'PAN', fileId: back });

    assert.deepEqual([asBack.statusCode, asFront.statusCode], [409, 409]);
    assert.equal(await references(front), 1);
    assert.equal(await references(back), 1);
  });

  it('still replaces both sides, and still accepts a front-only upload from an old app', async () => {
    const { user, driverId } = await driver('+919876580004');
    const oldFront = await uploadFile(user);
    const oldBack = await uploadFile(user);
    await submit(user, driverId, {
      documentType: 'DRIVING_LICENSE',
      fileId: oldFront,
      backFileId: oldBack,
    });

    const newFront = await uploadFile(user);
    const newBack = await uploadFile(user);
    const replaced = await submit(user, driverId, {
      documentType: 'DRIVING_LICENSE',
      fileId: newFront,
      backFileId: newBack,
    });
    assert.equal(replaced.statusCode, 201, replaced.payload);
    const frontOnly = await submit(user, driverId, {
      documentType: 'PAN',
      fileId: await uploadFile(user),
    });
    assert.equal(frontOnly.statusCode, 201, frontOnly.payload);

    const licence = await db().client.driverDocument.findFirstOrThrow({
      where: { driverId, documentType: 'DRIVING_LICENSE' },
    });
    assert.deepEqual([licence.fileId, licence.backFileId], [newFront, newBack]);
  });

  it('does not let a file be deleted while another request is attaching it', async () => {
    const { user, driverId } = await driver('+919876580005');
    const file = await uploadFile(user);

    const attaching = holdOpen(async (tx) => {
      await files().assertReferenceable(file, user.userId, 'DRIVER_DOCUMENT', tx);
      await tx.driverDocument.create({
        data: { driverId, documentType: 'DRIVING_LICENSE', fileId: file },
      });
    });
    await attaching.started;

    const removal = files().remove(file, user.userId);
    const blocked = await stillPending(removal);

    attaching.release();
    await attaching.done;
    await assert.rejects(removal, FileInUseError);
    assert.equal(blocked, true, 'the delete must wait for the attach, not slip past it');
    const row = await db().client.file.findUniqueOrThrow({ where: { id: file } });
    assert.equal(row.status, 'READY');
  });

  it('refuses one file as both sides of the same document at the database', async () => {
    const { user, driverId } = await driver('+919876580006');
    const file = await uploadFile(user);
    await submit(user, driverId, { documentType: 'DRIVING_LICENSE', fileId: file });

    await assert.rejects(
      db().client.driverDocument.updateMany({
        where: { driverId, documentType: 'DRIVING_LICENSE' },
        data: { backFileId: file },
      }),
      /back_file_id|check constraint|violates/i,
    );
  });
});

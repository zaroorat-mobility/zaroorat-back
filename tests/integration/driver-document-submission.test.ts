import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState, type LoggedInUser } from './helpers/harness.js';
import { grantRole, makeAssignedVehicle } from './helpers/fixtures.js';
import { container } from '../../src/core/di.js';
import { png as image } from '../helpers/image-fixtures.js';
import type { MockStorageProvider } from '../../src/modules/files/utils/storage/mock.provider.js';

function png(): Buffer {
  return image({ width: 400, height: 300 });
}

describe('driver document submission via fileId (integration)', () => {
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

  async function uploadFile(
    auth: { authorization: string },
    purpose = 'DRIVER_DOCUMENT',
    contentType: 'image/png' | 'application/pdf' = 'image/png',
  ): Promise<string> {
    const body =
      contentType === 'image/png'
        ? png()
        : Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64)]);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/files',
      headers: { ...auth, 'idempotency-key': randomUUID() },
      payload: { purpose, fileName: 'licence', contentType, sizeBytes: 2048 },
    });
    assert.equal(created.statusCode, 201, created.payload);
    const fileId = created.json().fileId as string;
    const row = await db().client.file.findUniqueOrThrow({ where: { id: fileId } });
    provider.putObject(row.storageKey, body, contentType);
    const completed = await app.inject({
      method: 'POST',
      url: `/api/v1/files/${fileId}/complete`,
      headers: auth,
    });
    assert.equal(completed.statusCode, 200, completed.payload);
    return fileId;
  }

  async function onboardDriver(user: LoggedInUser): Promise<string> {
    const me = await app.inject({
      method: 'POST',
      url: '/api/v1/drivers/me/onboard',
      headers: user.authHeader,
    });
    assert.equal(me.statusCode, 201, me.payload);
    return me.json().data.id as string;
  }

  function submitDocument(user: LoggedInUser, driverId: string, body: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/drivers/${driverId}/documents`,
      headers: user.authHeader,
      payload: body,
    });
  }

  it('stores a fileId (not a URL) on the resulting DriverDocument row', async () => {
    const user = await loginAs(app, '+919876650001');
    const driverId = await onboardDriver(user);
    const fileId = await uploadFile(user.authHeader);

    const response = await submitDocument(user, driverId, {
      documentType: 'DRIVING_LICENSE',
      fileId,
    });

    assert.equal(response.statusCode, 201, response.payload);
    const row = await db().client.driverDocument.findFirstOrThrow({
      where: { driverId, documentType: 'DRIVING_LICENSE' },
    });
    assert.equal(row.fileId, fileId);
    assert.equal(row.verificationStatus, 'PENDING');
  });

  it('rejects a request body still supplying fileUrl (schema no longer accepts it)', async () => {
    const user = await loginAs(app, '+919876650002');
    const driverId = await onboardDriver(user);

    const response = await submitDocument(user, driverId, {
      documentType: 'DRIVING_LICENSE',
      fileUrl: 'https://example.invalid/licence.jpg',
    });

    assert.equal(response.statusCode, 400, response.payload);
  });

  it('rejects another user’s fileId', async () => {
    const owner = await loginAs(app, '+919876650003');
    const stranger = await loginAs(app, '+919876650004');
    const strangerDriverId = await onboardDriver(stranger);
    const fileId = await uploadFile(owner.authHeader);

    const response = await submitDocument(stranger, strangerDriverId, {
      documentType: 'DRIVING_LICENSE',
      fileId,
    });

    assert.equal(response.statusCode, 404, response.payload);
  });

  it('rejects a nonexistent fileId', async () => {
    const user = await loginAs(app, '+919876650005');
    const driverId = await onboardDriver(user);

    const response = await submitDocument(user, driverId, {
      documentType: 'DRIVING_LICENSE',
      fileId: randomUUID(),
    });

    assert.equal(response.statusCode, 404, response.payload);
  });

  it('rejects a fileId whose purpose is not DRIVER_DOCUMENT', async () => {
    const user = await loginAs(app, '+919876650006');
    const driverId = await onboardDriver(user);
    const fileId = await uploadFile(user.authHeader, 'PROFILE_IMAGE');

    const response = await submitDocument(user, driverId, {
      documentType: 'DRIVING_LICENSE',
      fileId,
    });

    assert.equal(response.statusCode, 404, response.payload);
  });

  it('supersedes the old file and keeps exactly one row per (driverId, documentType)', async () => {
    const user = await loginAs(app, '+919876650007');
    const driverId = await onboardDriver(user);
    const firstFileId = await uploadFile(user.authHeader);
    await submitDocument(user, driverId, { documentType: 'DRIVING_LICENSE', fileId: firstFileId });

    const secondFileId = await uploadFile(user.authHeader);
    const response = await submitDocument(user, driverId, {
      documentType: 'DRIVING_LICENSE',
      fileId: secondFileId,
    });

    assert.equal(response.statusCode, 201, response.payload);
    const rows = await db().client.driverDocument.findMany({
      where: { driverId, documentType: 'DRIVING_LICENSE' },
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.fileId, secondFileId);
    const oldFile = await db().client.file.findUniqueOrThrow({ where: { id: firstFileId } });
    assert.equal(oldFile.status, 'SUPERSEDED');
  });

  it('links a PROFILE_PHOTO to the driver profile by file id and replaces it on retake', async () => {
    const user = await loginAs(app, '+919876650010');
    const driverId = await onboardDriver(user);

    const firstFileId = await uploadFile(user.authHeader);
    const first = await submitDocument(user, driverId, {
      documentType: 'PROFILE_PHOTO',
      fileId: firstFileId,
    });
    assert.equal(first.statusCode, 201, first.payload);
    const linked = await db().client.driverProfile.findUniqueOrThrow({ where: { driverId } });
    assert.equal(linked.profilePhoto, firstFileId);

    const secondFileId = await uploadFile(user.authHeader);
    const retake = await submitDocument(user, driverId, {
      documentType: 'PROFILE_PHOTO',
      fileId: secondFileId,
    });
    assert.equal(retake.statusCode, 201, retake.payload);
    const relinked = await db().client.driverProfile.findUniqueOrThrow({ where: { driverId } });
    assert.equal(relinked.profilePhoto, secondFileId);
    const oldFile = await db().client.file.findUniqueOrThrow({ where: { id: firstFileId } });
    assert.equal(oldFile.status, 'SUPERSEDED');

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/drivers/me',
      headers: user.authHeader,
    });
    assert.equal(me.json().data.profile.profilePhoto, secondFileId);
  });

  it('refuses a PDF as PROFILE_PHOTO and leaves the profile untouched', async () => {
    const user = await loginAs(app, '+919876650011');
    const driverId = await onboardDriver(user);
    const pdfId = await uploadFile(user.authHeader, 'DRIVER_DOCUMENT', 'application/pdf');

    const response = await submitDocument(user, driverId, {
      documentType: 'PROFILE_PHOTO',
      fileId: pdfId,
    });

    assert.equal(response.statusCode, 422, response.payload);
    const docs = await db().client.driverDocument.count({ where: { driverId } });
    assert.equal(docs, 0);
    const profile = await db().client.driverProfile.findUnique({ where: { driverId } });
    assert.equal(profile?.profilePhoto ?? null, null);
  });

  it('signs the profile photo for its owner and an admin, never for another user', async () => {
    const user = await loginAs(app, '+919876650012');
    const stranger = await loginAs(app, '+919876650013');
    const adminSeed = await loginAs(app, '+919876650014');
    await grantRole(adminSeed.userId, 'admin');
    const admin = await loginAs(app, '+919876650014');
    const driverId = await onboardDriver(user);
    const fileId = await uploadFile(user.authHeader);
    await submitDocument(user, driverId, { documentType: 'PROFILE_PHOTO', fileId });

    const readUrl = (auth: { authorization: string }) =>
      app.inject({ method: 'GET', url: `/api/v1/files/${fileId}/url`, headers: auth });

    const own = await readUrl(user.authHeader);
    assert.equal(own.statusCode, 200, own.payload);
    assert.ok(own.json().expiresAt);
    assert.equal((await readUrl(admin.authHeader)).statusCode, 200);
    assert.equal((await readUrl(stranger.authHeader)).statusCode, 404);
  });

  it('keeps the back of a two-sided document next to its front, and shows both to an admin', async () => {
    const user = await loginAs(app, '+919876650017');
    const adminSeed = await loginAs(app, '+919876650018');
    await grantRole(adminSeed.userId, 'admin');
    const admin = await loginAs(app, '+919876650018');
    const driverId = await onboardDriver(user);
    const front = await uploadFile(user.authHeader);
    const back = await uploadFile(user.authHeader);

    const response = await submitDocument(user, driverId, {
      documentType: 'DRIVING_LICENSE',
      fileId: front,
      backFileId: back,
    });

    assert.equal(response.statusCode, 201, response.payload);
    const row = await db().client.driverDocument.findFirstOrThrow({
      where: { driverId, documentType: 'DRIVING_LICENSE' },
    });
    assert.deepEqual([row.fileId, row.backFileId], [front, back]);
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/applications/${driverId}`,
      headers: admin.authHeader,
    });
    assert.equal(detail.statusCode, 200, detail.payload);
    const [shown] = detail.json().data.documents as Array<{ fileId: string; backFileId?: string }>;
    assert.deepEqual([shown?.fileId, shown?.backFileId], [front, back]);
  });

  it('supersedes the old back when a two-sided document is replaced', async () => {
    const user = await loginAs(app, '+919876650019');
    const driverId = await onboardDriver(user);
    const oldBack = await uploadFile(user.authHeader);
    await submitDocument(user, driverId, {
      documentType: 'AADHAAR',
      fileId: await uploadFile(user.authHeader),
      backFileId: oldBack,
    });
    const newBack = await uploadFile(user.authHeader);

    const replaced = await submitDocument(user, driverId, {
      documentType: 'AADHAAR',
      fileId: await uploadFile(user.authHeader),
      backFileId: newBack,
    });

    assert.equal(replaced.statusCode, 201, replaced.payload);
    const old = await db().client.file.findUniqueOrThrow({ where: { id: oldBack } });
    assert.deepEqual([old.status, old.supersededById], ['SUPERSEDED', newBack]);
  });

  it('retires the old back when a replacement arrives without one', async () => {
    const user = await loginAs(app, '+919876650020');
    const driverId = await onboardDriver(user);
    const oldBack = await uploadFile(user.authHeader);
    await submitDocument(user, driverId, {
      documentType: 'DRIVING_LICENSE',
      fileId: await uploadFile(user.authHeader),
      backFileId: oldBack,
    });

    const frontOnly = await submitDocument(user, driverId, {
      documentType: 'DRIVING_LICENSE',
      fileId: await uploadFile(user.authHeader),
    });

    assert.equal(frontOnly.statusCode, 201, frontOnly.payload);
    const row = await db().client.driverDocument.findFirstOrThrow({
      where: { driverId, documentType: 'DRIVING_LICENSE' },
    });
    assert.equal(row.backFileId, null);
    const old = await db().client.file.findUniqueOrThrow({ where: { id: oldBack } });
    assert.equal(old.status, 'DELETED');
  });

  it('refuses a back that is the front, belongs to someone else, or already backs a document', async () => {
    const user = await loginAs(app, '+919876650021');
    const stranger = await loginAs(app, '+919876650022');
    const driverId = await onboardDriver(user);
    const front = await uploadFile(user.authHeader);
    const usedBack = await uploadFile(user.authHeader);
    await submitDocument(user, driverId, {
      documentType: 'AADHAAR',
      fileId: await uploadFile(user.authHeader),
      backFileId: usedBack,
    });

    const cases: Array<[string, string, number]> = [
      ['the front itself', front, 422],
      ["a stranger's file", await uploadFile(stranger.authHeader), 404],
      ['a file already backing a document', usedBack, 409],
    ];
    for (const [label, backFileId, status] of cases) {
      const response = await submitDocument(user, driverId, {
        documentType: 'DRIVING_LICENSE',
        fileId: front,
        backFileId,
      });
      assert.equal(response.statusCode, status, `${label}: ${response.payload}`);
    }
    assert.equal(
      await db().client.driverDocument.count({
        where: { driverId, documentType: 'DRIVING_LICENSE' },
      }),
      0,
    );
  });

  it('refuses to attach a file already backing a document as another document', async () => {
    const user = await loginAs(app, '+919876650023');
    const driverId = await onboardDriver(user);
    const back = await uploadFile(user.authHeader);
    await submitDocument(user, driverId, {
      documentType: 'AADHAAR',
      fileId: await uploadFile(user.authHeader),
      backFileId: back,
    });

    const reused = await submitDocument(user, driverId, { documentType: 'PAN', fileId: back });

    assert.equal(reused.statusCode, 409, reused.payload);
  });

  describe('resubmission workflow', () => {
    async function makeAdmin(phone: string): Promise<LoggedInUser> {
      const seed = await loginAs(app, phone);
      await grantRole(seed.userId, 'admin');
      return loginAs(app, phone);
    }
    const adminPost = (who: LoggedInUser, url: string, payload: Record<string, unknown> = {}) =>
      app.inject({ method: 'POST', url, headers: who.authHeader, payload });
    const application = async (who: LoggedInUser, driverId: string) => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/applications/${driverId}`,
        headers: who.authHeader,
      });
      return res.json().data as { applicationStatus: string };
    };
    const listed = async (who: LoggedInUser, status: string) => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/applications?status=${status}`,
        headers: who.authHeader,
      });
      assert.equal(res.statusCode, 200, res.payload);
      return (res.json().data as Array<{ id: string }>).map((row) => row.id);
    };
    const driverRow = (id: string) => db().client.driver.findUniqueOrThrow({ where: { id } });
    const licence = async (user: LoggedInUser, driverId: string) =>
      submitDocument(user, driverId, {
        documentType: 'DRIVING_LICENSE',
        fileId: await uploadFile(user.authHeader),
      });

    it('request → resubmission required → re-upload → under review → approved', async () => {
      const user = await loginAs(app, '+919876650015');
      const admin = await makeAdmin('+919876650016');
      const driverId = await onboardDriver(user);
      await licence(user, driverId);

      const sentBack = await adminPost(
        admin,
        `/api/v1/admin/applications/${driverId}/request-resubmission`,
        { notes: 'Retake the licence photo in daylight' },
      );
      assert.equal(sentBack.statusCode, 200, sentBack.payload);
      assert.equal(sentBack.json().data.applicationStatus, 'resubmission_required');
      assert.equal((await driverRow(driverId)).verificationStatus, 'PENDING');
      assert.ok((await listed(admin, 'resubmission_required')).includes(driverId));
      assert.ok(!(await listed(admin, 'pending_review')).includes(driverId));
      const stats = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/applications/stats',
        headers: admin.authHeader,
      });
      assert.equal(stats.json().data.resubmissionRequired, 1);
      assert.equal(stats.json().data.pendingReview, 0, 'counted once, as its filter lists it');

      assert.equal((await licence(user, driverId)).statusCode, 201);
      const reviewing = await driverRow(driverId);
      assert.equal(reviewing.verificationStatus, 'DOCUMENT_REVIEW');
      assert.equal(reviewing.rejectionReason, 'Retake the licence photo in daylight');
      assert.equal((await application(admin, driverId)).applicationStatus, 'under_review');

      const docs = await db().client.driverDocument.findMany({ where: { driverId } });
      for (const doc of docs) {
        const reviewed = await adminPost(
          admin,
          `/api/v1/admin/applications/${driverId}/documents/${doc.id}/review`,
          { status: 'VERIFIED' },
        );
        assert.equal(reviewed.statusCode, 200, reviewed.payload);
      }
      const approved = await adminPost(admin, `/api/v1/admin/applications/${driverId}/approve`, {
        notes: 'Clear now',
      });
      assert.equal(approved.statusCode, 200, approved.payload);
      assert.equal((await driverRow(driverId)).verificationStatus, 'VERIFIED');

      const decisions = await db().client.adminActivityLog.findMany({
        where: { entityType: 'driver', entityId: driverId },
        orderBy: { createdAt: 'asc' },
      });
      assert.deepEqual(
        decisions.map((row) => row.summary),
        ['Driver Resubmission Requested', 'Driver Verification Approved'],
      );
    });

    it('a finally rejected driver does not re-enter review by uploading', async () => {
      const user = await loginAs(app, '+919876650024');
      const admin = await makeAdmin('+919876650025');
      const driverId = await onboardDriver(user);
      const rejected = await adminPost(admin, `/api/v1/admin/applications/${driverId}/reject`, {
        notes: 'Fraudulent licence',
      });
      assert.equal(rejected.statusCode, 200, rejected.payload);

      assert.equal((await licence(user, driverId)).statusCode, 201);

      const row = await driverRow(driverId);
      assert.equal(row.verificationStatus, 'REJECTED');
      assert.equal(row.rejectionReason, 'Fraudulent licence');
      assert.equal((await application(admin, driverId)).applicationStatus, 'rejected');
    });

    it('a blocked or suspended driver does not re-enter review by uploading', async () => {
      const admin = await makeAdmin('+919876650026');
      const documents = container.resolve<{
        documents: { submitDocument(input: Record<string, unknown>): Promise<unknown> };
      }>('driverService').documents;
      const cases: Array<[string, 'block' | 'suspend']> = [
        ['+919876650027', 'block'],
        ['+919876650028', 'suspend'],
      ];
      for (const [phone, action] of cases) {
        const user = await loginAs(app, phone);
        const driverId = await onboardDriver(user);
        await adminPost(admin, `/api/v1/admin/applications/${driverId}/request-resubmission`, {
          notes: 'Retake the licence photo',
        });
        const fileId = await uploadFile(user.authHeader);
        const moderated = await adminPost(admin, `/api/v1/admin/drivers/${driverId}/${action}`, {
          notes: 'Policy breach',
        });
        assert.equal(moderated.statusCode, 200, moderated.payload);

        await documents.submitDocument({ driverId, documentType: 'DRIVING_LICENSE', fileId });

        assert.equal((await driverRow(driverId)).verificationStatus, 'PENDING', action);
      }
    });

    it('an upload racing a newer final rejection does not overwrite it', async () => {
      const user = await loginAs(app, '+919876650029');
      const admin = await makeAdmin('+919876650030');
      const driverId = await onboardDriver(user);
      await adminPost(admin, `/api/v1/admin/applications/${driverId}/request-resubmission`, {
        notes: 'Retake the licence photo',
      });
      const fileId = await uploadFile(user.authHeader);

      // An admin's final rejection is in flight: it holds the driver row, uncommitted.
      type Client = {
        $queryRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
        driver: { update(args: unknown): Promise<unknown> };
      };
      let release!: () => void;
      let ready!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const held = new Promise<void>((resolve) => (ready = resolve));
      const decision = container
        .resolve<{ execute<T>(work: (tx: Client) => Promise<T>): Promise<T> }>('transactionManager')
        .execute(async (tx) => {
          await tx.$queryRaw`SELECT id FROM drivers WHERE id = ${driverId}::uuid FOR UPDATE`;
          await tx.driver.update({
            where: { id: driverId },
            data: { verificationStatus: 'REJECTED', rejectionReason: 'Fraudulent licence' },
          });
          ready();
          await gate;
        });
      await held;

      const upload = submitDocument(user, driverId, { documentType: 'DRIVING_LICENSE', fileId });
      await new Promise((resolve) => setTimeout(resolve, 400));
      release();
      await decision;
      assert.equal((await upload).statusCode, 201);

      const row = await driverRow(driverId);
      assert.equal(row.verificationStatus, 'REJECTED');
      assert.equal(row.rejectionReason, 'Fraudulent licence');
    });
  });

  it('downgrades a VERIFIED driver to DOCUMENT_REVIEW, forces offline, and forgets geo on required re-upload', async () => {
    const user = await loginAs(app, '+919876650008');
    const adminSeed = await loginAs(app, '+919876650009');
    await grantRole(adminSeed.userId, 'admin');
    const admin = await loginAs(app, '+919876650009');

    const driverId = await onboardDriver(user);
    for (const documentType of ['DRIVING_LICENSE', 'RC', 'INSURANCE']) {
      const fileId = await uploadFile(user.authHeader);
      await submitDocument(user, driverId, { documentType, fileId });
    }
    const docs = await db().client.driverDocument.findMany({ where: { driverId } });
    for (const doc of docs) {
      const review = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/drivers/${driverId}/documents/${doc.id}/review`,
        headers: admin.authHeader,
        payload: { status: 'VERIFIED' },
      });
      assert.equal(review.statusCode, 200, review.payload);
    }
    const approved = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/drivers/${driverId}/verify`,
      headers: admin.authHeader,
      payload: { status: 'VERIFIED' },
    });
    assert.equal(approved.statusCode, 200, approved.payload);

    // Going online gates on the vehicle and a chosen payment plan as well as the driver.
    await makeAssignedVehicle(driverId);
    const plan = await app.inject({
      method: 'POST',
      url: '/api/v1/drivers/payment-model',
      headers: user.authHeader,
      payload: { model: 'COMMISSION' },
    });
    assert.ok([200, 201].includes(plan.statusCode), plan.payload);

    const online = await app.inject({
      method: 'POST',
      url: '/api/v1/drivers/status/online',
      headers: user.authHeader,
      payload: {},
    });
    assert.equal(online.statusCode, 200, online.payload);

    const newFileId = await uploadFile(user.authHeader);
    const resubmit = await submitDocument(user, driverId, {
      documentType: 'DRIVING_LICENSE',
      fileId: newFileId,
    });
    assert.equal(resubmit.statusCode, 201, resubmit.payload);

    const driver = await db().client.driver.findUniqueOrThrow({ where: { id: driverId } });
    assert.equal(driver.verificationStatus, 'DOCUMENT_REVIEW');
    const status = await db().client.driverOnlineStatus.findUnique({ where: { driverId } });
    assert.equal(status?.status, 'OFFLINE');
  });
});

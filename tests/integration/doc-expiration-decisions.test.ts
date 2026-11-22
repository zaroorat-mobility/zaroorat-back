import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, resetState } from './helpers/harness.js';
import { container } from '../../src/core/di.js';
import type { TransactionManager } from '../../src/core/database/TransactionManager.js';
import type { DocExpirationJob } from '../../src/modules/drivers/jobs/doc-expiration.job.js';
import type { DriverVerificationStatus, UserStatus } from '../../src/generated/prisma/index.js';

/// The expiry sweep may take an expired licence out of service; it must not undo what an
/// operator decided about the driver. Drivers are written directly in each decided state,
/// with a VERIFIED licence that expired yesterday.
describe('document expiry and operator decisions (integration)', () => {
  let app: FastifyInstance;
  let seq = 0;

  before(async () => {
    app = await bootApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(async () => {
    await resetState();
  });

  interface State {
    verificationStatus: DriverVerificationStatus;
    rejectionReason?: string | null;
    isSuspended?: boolean;
    userStatus?: UserStatus;
  }

  async function driverWithExpiredLicence(state: State) {
    seq += 1;
    const user = await db().client.user.create({
      data: {
        phoneNumber: `+91987668${String(seq).padStart(4, '0')}`,
        status: state.userStatus ?? 'ACTIVE',
      },
    });
    const driver = await db().client.driver.create({
      data: {
        userId: user.id,
        driverCode: `DRV_EX${randomUUID().slice(0, 6).toUpperCase()}`,
        verificationStatus: state.verificationStatus,
        rejectionReason: state.rejectionReason ?? null,
        isSuspended: state.isSuspended ?? false,
      },
    });
    const document = await db().client.driverDocument.create({
      data: {
        driverId: driver.id,
        documentType: 'DRIVING_LICENSE',
        verificationStatus: 'VERIFIED',
        expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      },
    });
    return { driverId: driver.id, documentId: document.id };
  }

  const run = () => container.resolve<DocExpirationJob>('docExpirationJob').run();
  const driverState = (id: string) =>
    db().client.driver.findUniqueOrThrow({
      where: { id },
      select: { verificationStatus: true, rejectionReason: true },
    });
  const documentState = (id: string) =>
    db().client.driverDocument.findUniqueOrThrow({
      where: { id },
      select: { verificationStatus: true, rejectionReason: true },
    });

  /// Holds the driver row the way a decision or an upload does, applies `change` inside
  /// that transaction, and commits only once `during` (the job) has started waiting.
  async function whileHeld(
    driverId: string,
    change: (tx: Parameters<Parameters<TransactionManager['execute']>[0]>[0]) => Promise<void>,
    during: () => Promise<number>,
  ): Promise<number> {
    let release!: () => void;
    let ready!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const held = new Promise<void>((resolve) => (ready = resolve));
    const holder = container
      .resolve<TransactionManager>('transactionManager')
      .execute(async (tx) => {
        await tx.$queryRaw`SELECT id FROM drivers WHERE id = ${driverId}::uuid FOR UPDATE`;
        await change(tx);
        ready();
        await gate;
      });
    await held;
    const running = during();
    await new Promise((resolve) => setTimeout(resolve, 400));
    release();
    await holder;
    return running;
  }

  it('sends a verified driver back to review with the expiry note, as before', async () => {
    const { driverId, documentId } = await driverWithExpiredLicence({
      verificationStatus: 'VERIFIED',
    });

    assert.equal(await run(), 1);

    assert.deepEqual(await driverState(driverId), {
      verificationStatus: 'DOCUMENT_REVIEW',
      rejectionReason: 'Required document expired',
    });
    assert.deepEqual(await documentState(documentId), {
      verificationStatus: 'REJECTED',
      rejectionReason: 'Document expired',
    });
  });

  const decided: Array<[string, State]> = [
    [
      'a final rejection',
      { verificationStatus: 'REJECTED', rejectionReason: 'Fraudulent licence' },
    ],
    [
      'a resubmission request and its instructions',
      { verificationStatus: 'PENDING', rejectionReason: 'Retake the licence photo' },
    ],
    [
      'a resubmission already back in review, with its instructions',
      { verificationStatus: 'DOCUMENT_REVIEW', rejectionReason: 'Retake the licence photo' },
    ],
    ['a suspension', { verificationStatus: 'VERIFIED', isSuspended: true }],
    ['a SUSPENDED verification status', { verificationStatus: 'SUSPENDED' }],
    ['a suspended account', { verificationStatus: 'VERIFIED', userStatus: 'SUSPENDED' }],
    ['a block', { verificationStatus: 'VERIFIED', isSuspended: true, userStatus: 'DEACTIVATED' }],
    ['a blocked account', { verificationStatus: 'VERIFIED', userStatus: 'DEACTIVATED' }],
  ];
  for (const [label, state] of decided) {
    it(`leaves ${label} in place, while still expiring the document`, async () => {
      const { driverId, documentId } = await driverWithExpiredLicence(state);
      const before = await driverState(driverId);

      await run();

      assert.deepEqual(await driverState(driverId), before);
      assert.deepEqual(await documentState(documentId), {
        verificationStatus: 'REJECTED',
        rejectionReason: 'Document expired',
      });
    });
  }

  it('waits for an in-flight final rejection and leaves it in place', async () => {
    const { driverId, documentId } = await driverWithExpiredLicence({
      verificationStatus: 'VERIFIED',
    });

    const expired = await whileHeld(
      driverId,
      async (tx) => {
        await tx.driver.update({
          where: { id: driverId },
          data: { verificationStatus: 'REJECTED', rejectionReason: 'Fraudulent licence' },
        });
      },
      run,
    );

    assert.equal(expired, 1);
    assert.deepEqual(await driverState(driverId), {
      verificationStatus: 'REJECTED',
      rejectionReason: 'Fraudulent licence',
    });
    assert.equal((await documentState(documentId)).verificationStatus, 'REJECTED');
  });

  it('waits for an in-flight suspension and leaves the driver verified', async () => {
    const { driverId } = await driverWithExpiredLicence({ verificationStatus: 'VERIFIED' });

    await whileHeld(
      driverId,
      async (tx) => {
        await tx.driver.update({ where: { id: driverId }, data: { isSuspended: true } });
      },
      run,
    );

    assert.deepEqual(await driverState(driverId), {
      verificationStatus: 'VERIFIED',
      rejectionReason: null,
    });
  });

  it('does not expire a licence re-uploaded while the job ran, nor reword the driver', async () => {
    const { driverId, documentId } = await driverWithExpiredLicence({
      verificationStatus: 'VERIFIED',
    });

    // The upload path: the driver row lock, a fresh PENDING licence, the driver to review.
    const expired = await whileHeld(
      driverId,
      async (tx) => {
        await tx.driverDocument.update({
          where: { id: documentId },
          data: {
            verificationStatus: 'PENDING',
            expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
          },
        });
        await tx.driver.update({
          where: { id: driverId },
          data: {
            verificationStatus: 'DOCUMENT_REVIEW',
            rejectionReason: 'Required document re-submitted',
          },
        });
      },
      run,
    );

    assert.equal(expired, 0);
    assert.equal((await documentState(documentId)).verificationStatus, 'PENDING');
    assert.deepEqual(await driverState(driverId), {
      verificationStatus: 'DOCUMENT_REVIEW',
      rejectionReason: 'Required document re-submitted',
    });
  });
});

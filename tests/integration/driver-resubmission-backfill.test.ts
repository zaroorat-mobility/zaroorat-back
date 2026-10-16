import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, resetState } from './helpers/harness.js';
import { grantRole } from './helpers/fixtures.js';
import { container } from '../../src/core/di.js';
import type { TransactionManager } from '../../src/core/database/TransactionManager.js';
import { Prisma } from '../../src/generated/prisma/index.js';
import {
  applyResubmissionBackfill,
  assertAuthorizedActor,
  BackfillAborted,
  exitCodeFor,
  planResubmissionBackfill,
  RESUBMISSION_BACKFILL,
} from '../../src/modules/admin/driver-management/applications/resubmission-backfill.js';

/// The backfill against real tables: what the dry run selects, what applying changes — and
/// what it must leave alone. Drivers and their audit history are written directly, the way
/// the code of 2026-10-03 to 2026-10-13 left them.
describe('resubmission state backfill (integration)', () => {
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

  const at = (minute: number) => new Date(Date.UTC(2026, 9, 5, 10, minute));

  async function user(status: 'ACTIVE' | 'UNVERIFIED' | 'SUSPENDED' | 'DEACTIVATED' = 'ACTIVE') {
    seq += 1;
    const row = await db().client.user.create({
      data: { phoneNumber: `+91987669${String(seq).padStart(4, '0')}`, status },
    });
    return row.id;
  }

  async function admin(slug = 'admin') {
    const id = await user();
    await grantRole(id, slug);
    return id;
  }

  async function driver(
    reason: string | null,
    options: {
      userStatus?: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
      isSuspended?: boolean;
      userId?: string;
    } = {},
  ) {
    const created = await db().client.driver.create({
      data: {
        userId: options.userId ?? (await user(options.userStatus)),
        driverCode: `DRV_BF${randomUUID().slice(0, 6).toUpperCase()}`,
        verificationStatus: 'REJECTED',
        rejectionReason: reason,
        isSuspended: options.isSuspended ?? false,
      },
    });
    return created.id;
  }

  async function resubmissionRequested(
    driverId: string,
    actorId: string,
    minute: number,
    reason: string,
  ) {
    const row = await db().client.adminActivityLog.create({
      data: {
        actorId,
        action: 'UPDATE',
        entityType: 'driver',
        entityId: driverId,
        summary: 'Driver Resubmission Requested',
        createdAt: at(minute),
        metadata: {
          before: { verificationStatus: 'DOCUMENT_REVIEW', rejectionReason: null },
          after: {
            verificationStatus: 'REJECTED',
            rejectionReason: reason,
            decision: 'RESUBMISSION_REQUESTED',
          },
          notes: reason,
          result: 'SUCCESS',
        },
      },
    });
    return row.id;
  }

  async function decided(
    driverId: string,
    actorId: string,
    minute: number,
    action: 'APPROVE' | 'REJECT',
  ) {
    await db().client.adminActivityLog.create({
      data: {
        actorId,
        action,
        entityType: 'driver',
        entityId: driverId,
        summary:
          action === 'APPROVE' ? 'Driver Verification Approved' : 'Driver Verification Rejected',
        createdAt: at(minute),
        metadata: {
          after: { verificationStatus: action === 'APPROVE' ? 'VERIFIED' : 'REJECTED' },
          result: 'SUCCESS',
        },
      },
    });
  }

  const status = async (id: string) =>
    db().client.driver.findUniqueOrThrow({
      where: { id },
      select: { verificationStatus: true, rejectionReason: true },
    });
  const auditRows = () => db().client.adminActivityLog.count();
  const client = () => db().client;

  it('the dry run selects exactly the drivers sent back for corrections, and writes nothing', async () => {
    const ops = await user();
    const sentBack = await driver('Retake the licence photo');
    const source = await resubmissionRequested(sentBack, ops, 1, 'Retake the licence photo');
    const finallyRejected = await driver('Fraudulent licence');
    await resubmissionRequested(finallyRejected, ops, 1, 'Retake');
    await decided(finallyRejected, ops, 2, 'REJECT');
    const blocked = await driver('Retake', { userStatus: 'DEACTIVATED' });
    await resubmissionRequested(blocked, ops, 1, 'Retake');
    const suspended = await driver('Retake', { isSuspended: true });
    await resubmissionRequested(suspended, ops, 1, 'Retake');
    const legacy = await driver('Resubmission requested');
    const contradicted = await driver('Retake');
    await resubmissionRequested(contradicted, ops, 1, 'Retake');
    await decided(contradicted, ops, 2, 'APPROVE');
    const before = await auditRows();

    const plan = await planResubmissionBackfill(client());

    assert.deepEqual(
      plan.eligible.map((e) => [e.driverId, e.sourceAuditId]),
      [[sentBack, source]],
    );
    assert.deepEqual(Object.fromEntries(plan.excluded.map((e) => [e.driverId, e.reason])), {
      [finallyRejected]: 'FINAL_REJECTION',
      [blocked]: 'BLOCKED',
      [suspended]: 'SUSPENDED',
    });
    assert.deepEqual(Object.fromEntries(plan.manualReview.map((e) => [e.driverId, e.reason])), {
      [legacy]: 'NO_DECISION_AUDIT',
      [contradicted]: 'STATUS_CONTRADICTS_LATEST_DECISION',
    });
    assert.equal(
      plan.manualReview.find((e) => e.driverId === legacy)?.legacyDefaultInstructions,
      true,
    );
    assert.equal((await status(sentBack)).verificationStatus, 'REJECTED');
    assert.equal(await auditRows(), before);
    assert.doesNotMatch(
      JSON.stringify(plan),
      /\+91|Retake|Fraudulent/,
      'no phone numbers or instructions',
    );
  });

  it('applying moves only the eligible driver to PENDING, keeps the instructions, records the correction and notifies no one', async () => {
    const ops = await user();
    const operator = await admin();
    const sentBack = await driver('Retake the licence photo');
    const source = await resubmissionRequested(sentBack, ops, 1, 'Retake the licence photo');
    const finallyRejected = await driver('Fraudulent licence');
    await decided(finallyRejected, ops, 1, 'REJECT');
    const outboxBefore = await db().client.outboxEvent.count();

    const plan = await planResubmissionBackfill(client());
    const applied = await applyResubmissionBackfill(client(), plan, { actorId: operator });

    assert.deepEqual(
      applied.updated.map((u) => u.driverId),
      [sentBack],
    );
    assert.deepEqual(await status(sentBack), {
      verificationStatus: 'PENDING',
      rejectionReason: 'Retake the licence photo',
    });
    assert.equal((await status(finallyRejected)).verificationStatus, 'REJECTED');
    const correction = await db().client.adminActivityLog.findMany({
      where: { entityType: 'driver', entityId: sentBack, actorId: operator },
    });
    assert.equal(correction.length, 1);
    const meta = correction[0]!.metadata as { after: Record<string, unknown> };
    assert.equal('decision' in meta.after, false, 'a correction, not an invented decision');
    assert.deepEqual(meta.after, {
      verificationStatus: 'PENDING',
      backfill: RESUBMISSION_BACKFILL,
      sourceAuditId: source,
    });
    assert.equal(await db().client.outboxEvent.count(), outboxBefore, 'no events, so no SMS');
  });

  // ── Applying exactly the reviewed plan ────────────────────────────────────────

  it('stops before any change when a reviewed driver dropped out of the plan', async () => {
    const ops = await user();
    const operator = await admin();
    const laterRejected = await driver('Retake');
    await resubmissionRequested(laterRejected, ops, 1, 'Retake');
    const reworded = await driver('Retake');
    await resubmissionRequested(reworded, ops, 1, 'Retake');
    const plan = await planResubmissionBackfill(client());
    assert.equal(plan.eligible.length, 2);
    const before = await auditRows();

    // Between review and apply: an admin finally rejects one, and the other's note changes.
    await decided(laterRejected, ops, 5, 'REJECT');
    await db().client.driver.update({
      where: { id: reworded },
      data: { rejectionReason: 'Changed' },
    });

    await assert.rejects(
      applyResubmissionBackfill(client(), plan, { actorId: operator }),
      /changed since the reviewed dry run/,
    );
    assert.equal((await status(laterRejected)).verificationStatus, 'REJECTED');
    assert.equal((await status(reworded)).verificationStatus, 'REJECTED');
    assert.equal(await auditRows(), before + 1, 'only the REJECT decision was written');
  });

  it('stops before any change when a driver became eligible after the dry run', async () => {
    const ops = await user();
    const operator = await admin();
    const reviewed = await driver('Retake');
    await resubmissionRequested(reviewed, ops, 1, 'Retake');
    const plan = await planResubmissionBackfill(client());

    const newcomer = await driver('Retake');
    await resubmissionRequested(newcomer, ops, 2, 'Retake');

    await assert.rejects(
      applyResubmissionBackfill(client(), plan, { actorId: operator }),
      /changed since the reviewed dry run/,
    );
    assert.equal((await status(reviewed)).verificationStatus, 'REJECTED');
    assert.equal((await status(newcomer)).verificationStatus, 'REJECTED');
  });

  it('stops before any change when a reviewed driver now rests on a newer request', async () => {
    const ops = await user();
    const operator = await admin();
    const sentBack = await driver('Retake');
    await resubmissionRequested(sentBack, ops, 1, 'Retake');
    const plan = await planResubmissionBackfill(client());

    // Same driver, same instructions, but a different source request than the one reviewed.
    await resubmissionRequested(sentBack, ops, 5, 'Retake');

    await assert.rejects(
      applyResubmissionBackfill(client(), plan, { actorId: operator }),
      /changed since the reviewed dry run/,
    );
    assert.equal((await status(sentBack)).verificationStatus, 'REJECTED');
  });

  type Tx = Parameters<Parameters<TransactionManager['execute']>[0]>[0];

  /// Runs `change` in a transaction left open, holding whatever it locked or wrote, until the
  /// returned function commits it.
  async function hold(change: (tx: Tx) => Promise<unknown>): Promise<() => Promise<void>> {
    let release!: () => void;
    let ready!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const held = new Promise<void>((resolve) => (ready = resolve));
    const done = container.resolve<TransactionManager>('transactionManager').execute(
      async (tx) => {
        await change(tx);
        ready();
        await gate;
      },
      { timeout: 20_000 },
    );
    await Promise.race([held, done]);
    return async () => {
      release();
      await done;
    };
  }
  const lockDriver = (tx: Tx, id: string) =>
    tx.$queryRaw`SELECT id FROM drivers WHERE id = ${id}::uuid FOR UPDATE`;
  const pause = () => new Promise((resolve) => setTimeout(resolve, 400));

  it('waits for an in-flight decision on the driver, then re-checks instead of overwriting it', async () => {
    const ops = await user();
    const operator = await admin();
    const sentBack = await driver('Retake');
    await resubmissionRequested(sentBack, ops, 1, 'Retake');
    const plan = await planResubmissionBackfill(client());

    // An admin is approving the driver: the row is held, the status changes on commit.
    const commit = await hold(async (tx) => {
      await lockDriver(tx, sentBack);
      await tx.driver.update({ where: { id: sentBack }, data: { verificationStatus: 'VERIFIED' } });
    });
    const applying = applyResubmissionBackfill(client(), plan, { actorId: operator });
    await pause();
    await commit();
    const applied = await applying;

    assert.equal(applied.updated.length, 0);
    assert.equal(applied.skipped.length, 1);
    assert.equal((await status(sentBack)).verificationStatus, 'VERIFIED');
  });

  it('running it again changes nothing', async () => {
    const ops = await user();
    const operator = await admin();
    const sentBack = await driver('Retake');
    await resubmissionRequested(sentBack, ops, 1, 'Retake');
    await applyResubmissionBackfill(client(), await planResubmissionBackfill(client()), {
      actorId: operator,
    });
    const rowsAfterFirst = await auditRows();

    const second = await planResubmissionBackfill(client());
    const applied = await applyResubmissionBackfill(client(), second, { actorId: operator });

    assert.equal(second.eligible.length, 0);
    assert.equal(applied.updated.length, 0);
    assert.equal(await auditRows(), rowsAfterFirst);
    assert.equal((await status(sentBack)).verificationStatus, 'PENDING');
  });

  // ── Uploads made while the driver sat REJECTED ────────────────────────────────

  /// A document as the upload path leaves it: PENDING, stamped with the upload time.
  async function driverDocument(driverId: string, uploadedAt: Date) {
    return db().client.driverDocument.create({
      data: {
        driverId,
        documentType: 'DRIVING_LICENSE',
        verificationStatus: 'PENDING',
        createdAt: uploadedAt,
        updatedAt: uploadedAt,
      },
    });
  }
  /// A vehicle, linked as the driver's current one when `driverId` is given.
  async function vehicle(driverId: string | null) {
    const type = await db().client.vehicleType.findFirstOrThrow();
    const row = await db().client.vehicle.create({
      data: {
        registrationNumber: `KA01BF${randomUUID().slice(0, 6)}`,
        vehicleTypeId: type.id,
        currentDriverId: driverId,
      },
    });
    if (driverId) {
      await db().client.driver.update({
        where: { id: driverId },
        data: { currentVehicleId: row.id },
      });
    }
    return row.id;
  }
  async function vehicleDocument(vehicleId: string, uploadedAt: Date) {
    return db().client.vehicleDocument.create({
      data: {
        vehicleId,
        documentType: 'RC',
        verificationStatus: 'PENDING',
        createdAt: uploadedAt,
        updatedAt: uploadedAt,
      },
    });
  }

  it('sends drivers who uploaded since the request to manual review, and leaves their documents and instructions alone', async () => {
    const ops = await user();
    const operator = await admin();
    const byLicence = await driver('Retake');
    await resubmissionRequested(byLicence, ops, 30, 'Retake');
    const licence = await driverDocument(byLicence, at(45));
    const byVehicle = await driver('Retake');
    await resubmissionRequested(byVehicle, ops, 30, 'Retake');
    await vehicleDocument(await vehicle(byVehicle), at(45));
    const uploadedBefore = await driver('Retake');
    await resubmissionRequested(uploadedBefore, ops, 30, 'Retake');
    await driverDocument(uploadedBefore, at(0));
    await vehicleDocument(await vehicle(uploadedBefore), at(0));
    // No current vehicle: a document on a vehicle that is not linked to them is not theirs.
    const noVehicle = await driver('Retake');
    await resubmissionRequested(noVehicle, ops, 30, 'Retake');
    await vehicleDocument(await vehicle(null), at(45));

    const plan = await planResubmissionBackfill(client());

    assert.deepEqual(
      plan.eligible.map((e) => e.driverId).sort(),
      [uploadedBefore, noVehicle].sort(),
    );
    assert.deepEqual(Object.fromEntries(plan.manualReview.map((e) => [e.driverId, e.reason])), {
      [byLicence]: 'DOCUMENTS_UPLOADED_SINCE_REQUEST',
      [byVehicle]: 'DOCUMENTS_UPLOADED_SINCE_REQUEST',
    });

    const applied = await applyResubmissionBackfill(client(), plan, { actorId: operator });
    assert.deepEqual(
      applied.updated.map((u) => u.driverId).sort(),
      [uploadedBefore, noVehicle].sort(),
    );
    for (const id of [byLicence, byVehicle]) {
      assert.deepEqual(await status(id), {
        verificationStatus: 'REJECTED',
        rejectionReason: 'Retake',
      });
    }
    const after = await db().client.driverDocument.findUniqueOrThrow({ where: { id: licence.id } });
    assert.equal(after.verificationStatus, 'PENDING', 'no document decision is overwritten');
  });

  it('an upload after the dry run changes the plan, which stops the run', async () => {
    const ops = await user();
    const operator = await admin();
    const viaLicence = await driver('Retake');
    await resubmissionRequested(viaLicence, ops, 30, 'Retake');
    const viaVehicle = await driver('Retake');
    await resubmissionRequested(viaVehicle, ops, 30, 'Retake');
    const vehicleId = await vehicle(viaVehicle);
    const plan = await planResubmissionBackfill(client());
    assert.equal(plan.eligible.length, 2);

    await driverDocument(viaLicence, new Date());
    await vehicleDocument(vehicleId, new Date());

    await assert.rejects(
      applyResubmissionBackfill(client(), plan, { actorId: operator }),
      /changed since the reviewed dry run/,
    );
    assert.equal((await status(viaLicence)).verificationStatus, 'REJECTED');
    assert.equal((await status(viaVehicle)).verificationStatus, 'REJECTED');
  });

  it('re-checks uploads under the lock: an upload racing the apply is never overwritten', async () => {
    const ops = await user();
    const operator = await admin();
    const viaLicence = await driver('Retake');
    await resubmissionRequested(viaLicence, ops, 30, 'Retake');
    const viaVehicle = await driver('Retake');
    await resubmissionRequested(viaVehicle, ops, 30, 'Retake');
    // The RC was rejected before the request; the driver re-uploads it during the apply.
    const rc = await vehicleDocument(await vehicle(viaVehicle), at(0));
    await db().client.vehicleDocument.update({
      where: { id: rc.id },
      data: { verificationStatus: 'REJECTED', updatedAt: at(0) },
    });
    const plan = await planResubmissionBackfill(client());
    assert.equal(plan.eligible.length, 2);

    // Both uploads are in flight, uncommitted, when the apply starts: a licence upload holds
    // the driver row as the upload path does; the RC re-upload holds its document row.
    const commitLicence = await hold(async (tx) => {
      await lockDriver(tx, viaLicence);
      await tx.driverDocument.create({
        data: {
          driverId: viaLicence,
          documentType: 'DRIVING_LICENSE',
          verificationStatus: 'PENDING',
        },
      });
    });
    const commitRc = await hold((tx) =>
      tx.vehicleDocument.update({ where: { id: rc.id }, data: { verificationStatus: 'PENDING' } }),
    );
    const applying = applyResubmissionBackfill(client(), plan, { actorId: operator });
    await pause();
    await commitLicence();
    await commitRc();
    const applied = await applying;

    assert.equal(applied.updated.length, 0);
    assert.deepEqual(
      applied.skipped.map((s) => s.driverId).sort(),
      [viaLicence, viaVehicle].sort(),
    );
    for (const skipped of applied.skipped) assert.match(skipped.why, /after the request/);
    assert.equal((await status(viaLicence)).verificationStatus, 'REJECTED');
    assert.equal((await status(viaVehicle)).verificationStatus, 'REJECTED');
  });

  // ── One driver's failure ──────────────────────────────────────────────────────

  async function threeSentBack() {
    const ops = await user();
    for (let i = 0; i < 3; i += 1) {
      await resubmissionRequested(await driver('Retake'), ops, 1, 'Retake');
    }
    const plan = await planResubmissionBackfill(client());
    assert.equal(plan.eligible.length, 3);
    return { plan, ids: plan.eligible.map((e) => e.driverId) as [string, string, string] };
  }

  /// The client, with the conditional update of one driver replaced: fault injection for
  /// what a live database produces only by bad luck.
  function withUpdateOf(driverId: string, replacement: () => Promise<{ count: number }>) {
    const bound = (target: object, prop: string | symbol): unknown => {
      const value: unknown = Reflect.get(target, prop);
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    };
    const real = client();
    const driverOf = (tx: Tx) =>
      new Proxy(tx.driver, {
        get: (delegate, prop) =>
          prop === 'updateMany'
            ? (args: { where: { id?: string } }) =>
                args.where.id === driverId ? replacement() : delegate.updateMany(args as never)
            : bound(delegate, prop),
      });
    return new Proxy(real, {
      get: (target, prop) =>
        prop === '$transaction'
          ? (fn: (tx: Tx) => Promise<unknown>, options?: object) =>
              target.$transaction(
                (tx) =>
                  fn(
                    new Proxy(tx, {
                      get: (t, p) => (p === 'driver' ? driverOf(t) : bound(t, p)),
                    }),
                  ),
                options,
              )
          : bound(target, prop),
    });
  }

  it('records a driver whose row stays locked as failed, and corrects the others', async () => {
    const operator = await admin();
    const { plan, ids } = await threeSentBack();
    const [locked, ...others] = ids;

    const release = await hold((tx) => lockDriver(tx, locked));
    const applied = await applyResubmissionBackfill(
      client(),
      plan,
      { actorId: operator },
      { lockTimeoutMs: 200 },
    );
    await release();

    assert.deepEqual(
      applied.failed.map((f) => f.driverId),
      [locked],
    );
    assert.match(applied.failed[0]!.error, /lock timeout|55P03/);
    assert.deepEqual(applied.updated.map((u) => u.driverId).sort(), [...others].sort());
    assert.equal((await status(locked)).verificationStatus, 'REJECTED');
    assert.equal(exitCodeFor(applied), 2);

    // Safe to rerun: a fresh dry run holds only the driver that failed.
    const rerun = await planResubmissionBackfill(client());
    assert.deepEqual(
      rerun.eligible.map((e) => e.driverId),
      [locked],
    );
    const second = await applyResubmissionBackfill(client(), rerun, { actorId: operator });
    assert.deepEqual(
      second.updated.map((u) => u.driverId),
      [locked],
    );
    assert.equal(exitCodeFor(second), 0);
  });

  it('skips a driver whose conditional update matches nothing, and corrects the others', async () => {
    const operator = await admin();
    const { plan, ids } = await threeSentBack();

    const applied = await applyResubmissionBackfill(
      withUpdateOf(ids[1], async () => ({ count: 0 })),
      plan,
      { actorId: operator },
    );

    assert.deepEqual(
      applied.skipped.map((s) => [s.driverId, s.why]),
      [[ids[1], 'changed during the update']],
    );
    assert.deepEqual(
      applied.updated.map((u) => u.driverId),
      [ids[0], ids[2]],
    );
    assert.equal((await status(ids[1])).verificationStatus, 'REJECTED');
    assert.equal(exitCodeFor(applied), 0);
  });

  it('records a database failure for one driver, rolls back only that driver, and goes on', async () => {
    const operator = await admin();
    const { plan, ids } = await threeSentBack();
    const before = await auditRows();

    const applied = await applyResubmissionBackfill(
      withUpdateOf(ids[1], () =>
        Promise.reject(
          new Prisma.PrismaClientKnownRequestError('Transaction failed due to a write conflict', {
            code: 'P2034',
            clientVersion: 'test',
          }),
        ),
      ),
      plan,
      { actorId: operator },
    );

    assert.deepEqual(
      applied.failed.map((f) => [f.driverId, f.error.split(':')[0]]),
      [[ids[1], 'P2034']],
    );
    assert.deepEqual(
      applied.updated.map((u) => u.driverId),
      [ids[0], ids[2]],
    );
    assert.equal((await status(ids[1])).verificationStatus, 'REJECTED');
    assert.equal(await auditRows(), before + 2, 'no audit row for the driver that failed');
    assert.equal(exitCodeFor(applied), 2);
  });

  it('stops at a programming error or a lost database, reporting what it had done', async () => {
    const stoppers: Array<[string, () => Promise<{ count: number }>]> = [
      ['a bug', () => Promise.reject(new TypeError('undefined is not a function'))],
      [
        'a lost connection',
        () =>
          Promise.reject(
            new Prisma.PrismaClientKnownRequestError('Server has closed the connection.', {
              code: 'P1017',
              clientVersion: 'test',
            }),
          ),
      ],
    ];
    for (const [label, fault] of stoppers) {
      const operator = await admin();
      const { plan, ids } = await threeSentBack();

      await assert.rejects(
        applyResubmissionBackfill(withUpdateOf(ids[1], fault), plan, { actorId: operator }),
        (err: unknown) => {
          assert.ok(err instanceof BackfillAborted, label);
          assert.deepEqual(
            err.report.updated.map((u) => u.driverId),
            [ids[0]],
            label,
          );
          assert.deepEqual(err.report.failed, [], label);
          return true;
        },
      );
      assert.equal((await status(ids[0])).verificationStatus, 'PENDING', label);
      assert.equal((await status(ids[1])).verificationStatus, 'REJECTED', label);
      assert.equal(
        (await status(ids[2])).verificationStatus,
        'REJECTED',
        `${label}: not attempted`,
      );
      await resetState();
    }
  });

  // ── The operator ──────────────────────────────────────────────────────────────

  it('accepts only an active admin or system admin as the operator', async () => {
    await assertAuthorizedActor(client(), await admin('admin'));
    await assertAuthorizedActor(client(), await admin('system_admin'));

    const blockedAdmin = await user('DEACTIVATED');
    await grantRole(blockedAdmin, 'admin');
    const suspendedAdmin = await user('SUSPENDED');
    await grantRole(suspendedAdmin, 'admin');
    const unverifiedAdmin = await user('UNVERIFIED');
    await grantRole(unverifiedAdmin, 'admin');
    const deletedAdmin = await admin();
    await db().client.user.update({ where: { id: deletedAdmin }, data: { deletedAt: new Date() } });
    const revokedAdmin = await admin();
    await db().client.userRoleAssignment.updateMany({
      where: { userId: revokedAdmin },
      data: { revokedAt: new Date() },
    });
    const expiredAdmin = await admin();
    await db().client.userRoleAssignment.updateMany({
      where: { userId: expiredAdmin },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const refused: Array<[string, string]> = [
      ['an ordinary driver', await admin('driver')],
      ['a customer with no role', await user()],
      ['support staff', await admin('support')],
      ['finance staff', await admin('finance')],
      ['a blocked admin', blockedAdmin],
      ['a suspended admin', suspendedAdmin],
      ['an unverified admin', unverifiedAdmin],
      ['a deleted admin', deletedAdmin],
      ['an admin whose role was revoked', revokedAdmin],
      ['an admin whose role expired', expiredAdmin],
      ['no such user', randomUUID()],
      ['not a user id', 'ops@example.com'],
    ];
    for (const [label, id] of refused) {
      await assert.rejects(assertAuthorizedActor(client(), id), /Refusing/, label);
    }
  });

  it('refuses an admin whose role no longer grants drivers:verify', async () => {
    const operator = await admin();
    const role = await db().client.role.findUniqueOrThrow({ where: { slug: 'admin' } });
    const permission = await db().client.permission.findUniqueOrThrow({
      where: { code: 'drivers:verify' },
    });
    // Restored by the next resetState(), which re-seeds the role grants.
    await db().client.rolePermission.delete({
      where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
    });
    await assert.rejects(assertAuthorizedActor(client(), operator), /drivers:verify/);
  });

  it('re-checks the operator at apply: a role revoked after the dry run stops it before any change', async () => {
    const ops = await user();
    const operator = await admin();
    const sentBack = await driver('Retake');
    await resubmissionRequested(sentBack, ops, 1, 'Retake');
    await assertAuthorizedActor(client(), operator);
    const plan = await planResubmissionBackfill(client());
    const before = await auditRows();

    await db().client.userRoleAssignment.updateMany({
      where: { userId: operator },
      data: { revokedAt: new Date() },
    });
    await assert.rejects(
      applyResubmissionBackfill(client(), plan, { actorId: operator }),
      /Refusing/,
    );
    assert.equal((await status(sentBack)).verificationStatus, 'REJECTED');
    assert.equal(await auditRows(), before);
  });

  it('refuses an operator who is one of the drivers to change, before changing anyone', async () => {
    const ops = await user();
    const operator = await admin();
    const self = await driver('Retake', { userId: operator });
    await resubmissionRequested(self, ops, 1, 'Retake');
    const other = await driver('Retake');
    await resubmissionRequested(other, ops, 1, 'Retake');
    const plan = await planResubmissionBackfill(client());
    assert.equal(plan.eligible.length, 2);

    await assert.rejects(
      applyResubmissionBackfill(client(), plan, { actorId: operator }),
      /their own/,
    );
    assert.equal((await status(self)).verificationStatus, 'REJECTED');
    assert.equal((await status(other)).verificationStatus, 'REJECTED');
  });
});

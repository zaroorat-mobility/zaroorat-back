import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState, type LoggedInUser } from './helpers/harness.js';
import { container } from '../../src/core/di.js';
import { userConfig } from '../../src/config/user/index.js';
import { png as image } from '../helpers/image-fixtures.js';
import type { AccountService } from '../../src/modules/users/account.service.js';
import type { AccountErasureJob } from '../../src/modules/users/jobs/account-erasure.job.js';
import type { MockStorageProvider } from '../../src/modules/files/providers/mock.provider.js';

/**
 * A phone number no other test in this file has used.
 *
 * Every test here registers, erases, and sometimes re-registers the same person,
 * and erasure deliberately returns a number to circulation. Sharing one number
 * across twenty-one tests makes each of them depend on the previous one's
 * `TRUNCATE` having fully landed — which is a race, and it flakes. A fresh
 * number costs nothing and removes the dependency entirely.
 */
let issued = 8000;
const phone = (): string => `+91987651${(issued += 1)}`;

const DELETE_REQUEST = '/api/v1/users/me/delete-request';
const DAY_MS = 24 * 60 * 60 * 1000;

/** A valid 800x600 PNG from the shared builder. */
function png(): Buffer {
  return image({ width: 800, height: 600 });
}

/**
 * The deletion ledger and the erasure that discharges it (R-USER-18/19,
 * doc 02 §2.8, doc 03 §6).
 *
 * `POST /me/delete-request` used to record its promise only as an outbox event —
 * a dispatch queue, not a ledger — so the endpoint accepted an obligation nothing
 * could discharge (`IMPLEMENTATION_STATUS` §8.3). What needs a real database here
 * is that the row exists, that a restore cancels it, and that the erasure leaves
 * an identity behind that no longer names anybody.
 */
describe('account erasure (integration)', () => {
  let app: FastifyInstance;
  let job: AccountErasureJob;
  let provider: MockStorageProvider;
  /** This test's departing account. Reassigned per test, never reused. */
  let leaver: string;

  beforeEach(() => {
    leaver = phone();
  });

  before(async () => {
    app = await bootApp();
    job = container.resolve<AccountErasureJob>('accountErasureJob');
    provider = container.resolve<MockStorageProvider>('storageProvider');
  });
  after(async () => {
    await app.close();
  });
  // After, matching every other suite. Resetting on the way *in* looks safer and
  // is not: `TRUNCATE` takes an ACCESS EXCLUSIVE lock on fifty cascading tables,
  // and a truncate that lands while the test's first login is in flight wipes the
  // account the test just created. Measured — moving it here made a suite that
  // failed three times in five deterministic.
  afterEach(async () => {
    await resetState();
    provider.reset();
  });

  const account = () => container.resolve<AccountService>('accountService');

  /** Ask for erasure as the authenticated caller, asserting it was accepted. */
  async function requestDeletion(user: LoggedInUser) {
    const response = await app.inject({
      method: 'POST',
      url: DELETE_REQUEST,
      headers: user.authHeader,
    });
    assert.equal(response.statusCode, 202, response.payload);
    return response;
  }

  /** The ledger row for an account, whatever state it is in. */
  function ledgerRow(userId: string) {
    return db().client.accountDeletionRequest.findFirstOrThrow({ where: { userId } });
  }

  /**
   * Age a request until its window has closed, standing in for the wait.
   *
   * Both columns move, because only moving `scheduledFor` would forge a row that
   * could never occur — `ck_deletion_requests_window` refuses a request that
   * comes due before it was made, and a test should not need an impossible row.
   */
  async function makeDue(userId: string): Promise<void> {
    const window = userConfig.deletionRetentionDays * DAY_MS;
    const requestedAt = new Date(Date.now() - window - DAY_MS);
    await db().client.accountDeletionRequest.updateMany({
      where: { userId },
      data: { requestedAt, scheduledFor: new Date(requestedAt.getTime() + window) },
    });
  }

  /** Upload, complete, and attach an avatar. Returns its file id. */
  async function attachAvatar(user: LoggedInUser): Promise<string> {
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
    assert.equal(created.statusCode, 201, created.payload);
    const fileId = created.json().fileId as string;

    const row = await db().client.file.findUniqueOrThrow({ where: { id: fileId } });
    provider.putObject(row.storageKey, png(), 'image/png');
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/files/${fileId}/complete`,
          headers: user.authHeader,
        })
      ).statusCode,
      200,
    );

    const patched = await app.inject({
      method: 'PATCH',
      url: '/api/v1/users/me/profile',
      headers: user.authHeader,
      payload: { profileImageFileId: fileId },
    });
    assert.equal(patched.statusCode, 200, patched.payload);
    return fileId;
  }

  /** Give the account something to lose. */
  async function seedPersonalData(user: LoggedInUser): Promise<void> {
    await app.inject({
      method: 'PATCH',
      url: '/api/v1/users/me/profile',
      headers: user.authHeader,
      payload: { firstName: 'Asha', lastName: 'Rao' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/users/me/emergency-contacts',
      headers: user.authHeader,
      payload: { contactName: 'Ravi', phoneNumber: '+919876500999', relationship: 'BROTHER' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/users/me/saved-places',
      headers: user.authHeader,
      payload: {
        label: 'Home',
        address: '4th Cross, Indiranagar',
        latitude: 12.97,
        longitude: 77.59,
      },
    });
  }

  // ── The ledger ────────────────────────────────────────────────────────────

  describe('recording the request', () => {
    it('writes a pending row the job can find', async () => {
      const user = await loginAs(app, leaver);

      const response = await requestDeletion(user);
      assert.equal(response.statusCode, 202, response.payload);

      const row = await ledgerRow(user.userId);
      assert.equal(row.status, 'PENDING');
      assert.equal(row.erasedAt, null);
      assert.equal(row.cancelledAt, null);
    });

    it('records the same date it told the user', async () => {
      const user = await loginAs(app, leaver);

      const { scheduledFor } = (await requestDeletion(user)).json();

      const row = await ledgerRow(user.userId);
      assert.equal(row.scheduledFor.toISOString(), scheduledFor);
    });

    it('schedules it the configured window ahead', async () => {
      const user = await loginAs(app, leaver);
      const before = Date.now();

      await requestDeletion(user);

      const row = await ledgerRow(user.userId);
      const expected = before + userConfig.deletionRetentionDays * DAY_MS;
      assert.ok(Math.abs(row.scheduledFor.getTime() - expected) < 10_000, `${row.scheduledFor}`);
    });

    it('refuses a second open request for the same account', async () => {
      // The partial unique index. Two rows would both come due, and the second
      // would emit a duplicate audit event for an erasure that happened once.
      const user = await loginAs(app, leaver);
      await requestDeletion(user);

      await assert.rejects(
        () =>
          db().client.accountDeletionRequest.create({
            data: { userId: user.userId, scheduledFor: new Date(Date.now() + DAY_MS) },
          }),
        /Unique constraint failed on the fields: \(`user_id`\)/,
      );
    });

    it('refuses a request that comes due before it was made', async () => {
      const user = await loginAs(app, leaver);

      await assert.rejects(
        () =>
          db().client.accountDeletionRequest.create({
            data: { userId: user.userId, scheduledFor: new Date(Date.now() - DAY_MS) },
          }),
        /ck_deletion_requests_window/,
      );
    });

    it('refuses a status and timestamp that disagree', async () => {
      // `ERASED` with no `erased_at` makes "when was this discharged?"
      // unanswerable by the only table that claims to answer it.
      const user = await loginAs(app, leaver);
      await requestDeletion(user);
      const row = await ledgerRow(user.userId);

      await assert.rejects(
        () =>
          db().client.accountDeletionRequest.update({
            where: { id: row.id },
            data: { status: 'ERASED' },
          }),
        /ck_deletion_requests_status_timestamps/,
      );
    });
  });

  // ── Cancellation ──────────────────────────────────────────────────────────

  describe('restoring an account', () => {
    it('cancels the pending erasure', async () => {
      // Without this the account comes back, the user uses it, and the job
      // erases them on the original date anyway.
      const user = await loginAs(app, leaver);
      const operator = await loginAs(app, phone());
      await requestDeletion(user);

      await account().restore(user.userId, operator.userId);

      const row = await ledgerRow(user.userId);
      assert.equal(row.status, 'CANCELLED');
      assert.ok(row.cancelledAt);
    });

    it('leaves a restored account untouched when the job runs', async () => {
      const user = await loginAs(app, leaver);
      const operator = await loginAs(app, phone());
      await seedPersonalData(user);
      await requestDeletion(user);
      await account().restore(user.userId, operator.userId);
      await makeDue(user.userId);

      const result = await job.run();

      assert.equal(result.scanned, 0, 'a cancelled request is not due');
      assert.equal(result.erased, 0);
      const identity = await db().client.user.findUniqueOrThrow({ where: { id: user.userId } });
      assert.equal(identity.phoneNumber, leaver, 'still theirs');
    });

    it('lets the user ask again, on a fresh window', async () => {
      const user = await loginAs(app, leaver);
      const operator = await loginAs(app, phone());
      await requestDeletion(user);
      const before = await db().client.user.findUniqueOrThrow({ where: { id: user.userId } });
      assert.equal(before.deletedAt, null, 'a departure is not a deletion');
      await account().restore(user.userId, operator.userId);

      const again = await loginAs(app, leaver);
      assert.equal((await requestDeletion(again)).statusCode, 202);

      const rows = await db().client.accountDeletionRequest.findMany({
        where: { userId: user.userId },
        orderBy: { requestedAt: 'asc' },
      });
      assert.deepEqual(
        rows.map((row) => row.status),
        ['CANCELLED', 'PENDING'],
      );
    });
  });

  // ── The erasure ───────────────────────────────────────────────────────────

  describe('erasing a due account', () => {
    it('does nothing before the window closes', async () => {
      const user = await loginAs(app, leaver);
      await requestDeletion(user);

      const result = await job.run();

      assert.equal(result.scanned, 0);
      assert.equal((await ledgerRow(user.userId)).status, 'PENDING');
    });

    it('removes the profile, the contacts, and the places', async () => {
      const user = await loginAs(app, leaver);
      await seedPersonalData(user);
      await requestDeletion(user);
      await makeDue(user.userId);

      const result = await job.run();
      assert.equal(result.erased, 1, JSON.stringify(result));

      const client = db().client;
      assert.equal(await client.userProfile.count({ where: { userId: user.userId } }), 0);
      assert.equal(await client.emergencyContact.count({ where: { userId: user.userId } }), 0);
      assert.equal(await client.savedPlace.count({ where: { userId: user.userId } }), 0);
    });

    it('keeps the identity row and strips every identifier from it', async () => {
      const user = await loginAs(app, leaver);
      await requestDeletion(user);
      await makeDue(user.userId);

      await job.run();

      const identity = await db().client.user.findUniqueOrThrow({ where: { id: user.userId } });
      assert.equal(identity.id, user.userId, 'the row survives — 50 tables reference it');
      assert.notEqual(identity.phoneNumber, leaver);
      assert.equal(identity.email, null);
      assert.equal(identity.isPhoneVerified, false);
      assert.ok(identity.deletedAt, 'and it is soft-deleted');
    });

    it('leaves a phone number no client input could ever match', async () => {
      const user = await loginAs(app, leaver);
      await requestDeletion(user);
      await makeDue(user.userId);

      await job.run();

      const identity = await db().client.user.findUniqueOrThrow({ where: { id: user.userId } });
      assert.ok(!identity.phoneNumber.startsWith('+'), 'not E.164, so no login can reach it');
      assert.ok(identity.phoneNumber.includes(user.userId), 'unique per account');
    });

    it('frees the number for a fresh signup', async () => {
      // The whole point of the partial unique index: erasure returns the phone
      // to circulation, and the new account is a different person.
      const user = await loginAs(app, leaver);
      await requestDeletion(user);
      await makeDue(user.userId);
      await job.run();

      const reborn = await loginAs(app, leaver);

      assert.notEqual(reborn.userId, user.userId);
    });

    it('closes the ledger row', async () => {
      const user = await loginAs(app, leaver);
      await requestDeletion(user);
      await makeDue(user.userId);

      await job.run();

      const row = await ledgerRow(user.userId);
      assert.equal(row.status, 'ERASED');
      assert.ok(row.erasedAt);
    });

    it('audits the erasure with counts, not contents', async () => {
      const user = await loginAs(app, leaver);
      await seedPersonalData(user);
      await requestDeletion(user);
      await makeDue(user.userId);

      await job.run();

      const rows = await db().client.outboxEvent.findMany({
        where: { eventType: 'user.account.erased' },
      });
      assert.equal(rows.length, 1);
      const { data } = rows[0]!.payload as unknown as { data: Record<string, unknown> };
      assert.deepEqual(data, {
        userId: user.userId,
        emergencyContacts: 1,
        savedPlaces: 1,
        profile: 1,
        avatarReleased: false,
      });
    });

    it('is idempotent — a second run finds nothing to do', async () => {
      const user = await loginAs(app, leaver);
      await requestDeletion(user);
      await makeDue(user.userId);
      await job.run();

      const second = await job.run();

      assert.equal(second.scanned, 0);
      const rows = await db().client.outboxEvent.findMany({
        where: { eventType: 'user.account.erased' },
      });
      assert.equal(rows.length, 1, 'one irreversible act, one audit record');
    });

    it('releases the avatar to FILES rather than deleting the object itself', async () => {
      const user = await loginAs(app, leaver);
      const fileId = await attachAvatar(user);
      await requestDeletion(user);
      await makeDue(user.userId);

      await job.run();

      const file = await db().client.file.findUniqueOrThrow({ where: { id: fileId } });
      assert.equal(file.status, 'DELETED', 'soft-deleted, for FILES retention to erase');
      assert.ok(file.deletedAt);
      // FILES owns when the bytes go. Reaching into its bucket from here would
      // put two schedules in charge of one deletion.
      assert.equal(file.erasedAt, null);
    });
  });

  // ── Refusals ──────────────────────────────────────────────────────────────

  describe('refusals', () => {
    it('holds back an account with an open dispute', async () => {
      const user = await loginAs(app, leaver);
      await requestDeletion(user);
      await makeDue(user.userId);
      await db().client.supportTicket.create({
        data: {
          userId: user.userId,
          ticketNumber: `TKT-${randomUUID().slice(0, 8)}`,
          subject: 'Charged twice',
          status: 'OPEN',
        },
      });

      const result = await job.run();

      assert.equal(result.blocked, 1);
      assert.equal(result.erased, 0);
    });

    it('leaves the blocked account entirely intact', async () => {
      const user = await loginAs(app, leaver);
      await seedPersonalData(user);
      await requestDeletion(user);
      await makeDue(user.userId);
      await db().client.supportTicket.create({
        data: {
          userId: user.userId,
          ticketNumber: `TKT-${randomUUID().slice(0, 8)}`,
          subject: 'Charged twice',
          status: 'OPEN',
        },
      });

      await job.run();

      const identity = await db().client.user.findUniqueOrThrow({ where: { id: user.userId } });
      assert.equal(identity.phoneNumber, leaver);
      assert.equal(await db().client.userProfile.count({ where: { userId: user.userId } }), 1);
      assert.equal((await ledgerRow(user.userId)).status, 'PENDING', 'still owed');
    });

    it('erases it once the dispute closes', async () => {
      const user = await loginAs(app, leaver);
      await requestDeletion(user);
      await makeDue(user.userId);
      const ticket = await db().client.supportTicket.create({
        data: {
          userId: user.userId,
          ticketNumber: `TKT-${randomUUID().slice(0, 8)}`,
          subject: 'Charged twice',
          status: 'OPEN',
        },
      });
      assert.equal((await job.run()).blocked, 1);

      await db().client.supportTicket.update({
        where: { id: ticket.id },
        data: { status: 'RESOLVED' },
      });

      assert.equal((await job.run()).erased, 1);
    });
  });
});

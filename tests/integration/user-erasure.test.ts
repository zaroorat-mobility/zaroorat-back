import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState, type LoggedInUser } from './helpers/harness.js';
import { container } from '../../src/core/di.js';
import { userConfig } from '../../src/config/user/index.js';
import { png as image } from '../helpers/image-fixtures.js';
import type { AccountService } from '../../src/modules/users/services/account/account.service.js';
import type { AccountErasureJob } from '../../src/modules/users/jobs/account-erasure.job.js';
import type { MockStorageProvider } from '../../src/modules/files/providers/mock.provider.js';

let issued = 8000;
const phone = (): string => `+91987651${(issued += 1)}`;

const DELETE_REQUEST = '/api/v1/users/me/delete-request';
const DAY_MS = 24 * 60 * 60 * 1000;

function png(): Buffer {
  return image({ width: 800, height: 600 });
}

describe('account erasure (integration)', () => {
  let app: FastifyInstance;
  let job: AccountErasureJob;
  let provider: MockStorageProvider;
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

  afterEach(async () => {
    await resetState();
    provider.reset();
  });

  const account = () => container.resolve<AccountService>('accountService');

  async function requestDeletion(user: LoggedInUser) {
    const response = await app.inject({
      method: 'POST',
      url: DELETE_REQUEST,
      headers: user.authHeader,
    });
    assert.equal(response.statusCode, 202, response.payload);
    return response;
  }

  function ledgerRow(userId: string) {
    return db().client.accountDeletionRequest.findFirstOrThrow({ where: { userId } });
  }

  async function makeDue(userId: string): Promise<void> {
    const window = userConfig.deletionRetentionDays * DAY_MS;
    const requestedAt = new Date(Date.now() - window - DAY_MS);
    await db().client.accountDeletionRequest.updateMany({
      where: { userId },
      data: { requestedAt, scheduledFor: new Date(requestedAt.getTime() + window) },
    });
  }

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

  describe('restoring an account', () => {
    it('cancels the pending erasure', async () => {
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

    it('erases nothing when a restore commits while the job is running', async () => {
      const user = await loginAs(app, leaver);
      const operator = await loginAs(app, phone());
      await seedPersonalData(user);
      await requestDeletion(user);
      await makeDue(user.userId);

      const [result] = await Promise.all([
        job.run(),
        account().restore(user.userId, operator.userId),
      ]);

      const identity = await db().client.user.findUniqueOrThrow({ where: { id: user.userId } });
      const ledger = await ledgerRow(user.userId);

      if (identity.deletedAt === null) {
        assert.equal(ledger.status, 'CANCELLED', 'restore won');
        assert.equal(identity.phoneNumber, leaver, 'the number is still theirs');
        assert.equal(result.erased, 0);
        assert.ok(
          (await db().client.emergencyContact.count({ where: { userId: user.userId } })) > 0,
          'and nothing was scrubbed — no partial erasure',
        );
      } else {
        assert.equal(ledger.status, 'ERASED', 'erasure won');
        assert.equal(result.erased, 1);
        assert.equal(
          await db().client.emergencyContact.count({ where: { userId: user.userId } }),
          0,
          'and the scrub completed',
        );
      }

      const erasedEvents = await db().client.outboxEvent.count({
        where: { eventType: 'user.account.erased' },
      });
      assert.equal(
        erasedEvents,
        identity.deletedAt === null ? 0 : 1,
        'an erasure is audited exactly when it happened',
      );
    });

    it('never leaves a scrubbed account with a cancelled request', async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const user = await loginAs(app, leaver);
        const operator = await loginAs(app, phone());
        await seedPersonalData(user);
        await requestDeletion(user);
        await makeDue(user.userId);

        await Promise.all([job.run(), account().restore(user.userId, operator.userId)]);

        const identity = await db().client.user.findUniqueOrThrow({ where: { id: user.userId } });
        const ledger = await ledgerRow(user.userId);
        assert.ok(
          !(ledger.status === 'CANCELLED' && identity.deletedAt !== null),
          'an account was erased against a cancelled request',
        );
        await resetState();
      }
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

    describe('erasure completeness', () => {
      it('deletes the OTP trail, which is keyed by the phone number itself', async () => {
        const user = await loginAs(app, leaver);
        await requestDeletion(user);
        await makeDue(user.userId);

        assert.ok(
          (await db().client.otpVerification.count({ where: { phoneNumber: leaver } })) > 0,
          'precondition: the trail exists',
        );

        await job.run();

        assert.equal(
          await db().client.otpVerification.count({ where: { phoneNumber: leaver } }),
          0,
          'the real number must not survive erasure in the OTP trail',
        );
        assert.equal(
          await db().client.otpVerification.count({ where: { userId: user.userId } }),
          0,
        );
      });

      it('strips IP and user-agent from the session history, keeping the rows', async () => {
        const user = await loginAs(app, leaver);
        await requestDeletion(user);
        await makeDue(user.userId);

        await job.run();

        const sessions = await db().client.userSession.findMany({
          where: { userId: user.userId },
        });
        assert.ok(sessions.length > 0, 'the history survives for security review (R-AUTH-29)');
        for (const session of sessions) {
          assert.equal(session.ipAddress, null);
          assert.equal(session.userAgent, null);
        }
      });

      it('strips the fingerprint and push token from devices, keeping the rows', async () => {
        const user = await loginAs(app, leaver);
        await requestDeletion(user);
        await makeDue(user.userId);

        await job.run();

        const devices = await db().client.userDevice.findMany({ where: { userId: user.userId } });
        for (const device of devices) {
          assert.equal(device.fingerprint, null);
          assert.equal(device.fcmToken, null);
          assert.equal(device.deviceId, null);
          assert.equal(device.trustState, 'REVOKED');
        }
      });

      it('leaves no plaintext phone number anywhere in the durable event stream', async () => {
        const user = await loginAs(app, leaver);
        await requestDeletion(user);
        await makeDue(user.userId);

        await job.run();

        const events = await db().client.outboxEvent.findMany();
        assert.ok(events.length > 0, 'precondition: the audit trail exists');
        const serialized = JSON.stringify(events.map((event) => event.payload));
        assert.ok(
          !serialized.includes(leaver),
          'the erased number must not remain in outbox_events',
        );
        assert.ok(!serialized.includes(user.accessToken));
      });
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
        devices: 1,
        sessions: 1,
        otpAttempts: 1,
        avatarReleased: false,
      });

      for (const [field, value] of Object.entries(data)) {
        if (field === 'userId') continue;
        assert.ok(
          typeof value === 'number' || typeof value === 'boolean',
          `${field} must be a count or a flag, not content (got ${typeof value})`,
        );
      }
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

      assert.equal(file.erasedAt, null);
    });
  });

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

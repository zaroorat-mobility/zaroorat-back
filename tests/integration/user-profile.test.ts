import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';

const BASE = '/api/v1/users';

describe('user profile (integration)', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await bootApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(async () => {
    await resetState();
  });

  const phoneA = '+919876511001';
  const phoneB = '+919876511002';

  async function patch(token: string, payload: Record<string, unknown>) {
    return app.inject({
      method: 'PATCH',
      url: `${BASE}/me/profile`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
  }

  describe('the deny-by-default gate covers this module (doc 02 §3)', () => {
    it('refuses an unauthenticated read and an unauthenticated write', async () => {
      for (const [method, url] of [
        ['GET', `${BASE}/me`],
        ['PATCH', `${BASE}/me/profile`],
      ] as const) {
        const res = await app.inject({ method, url, payload: {} });
        assert.equal(res.statusCode, 401, `${method} ${url} must be protected`);
        assert.equal(res.json().error.code, 'TOKEN_INVALID');
      }
    });
  });

  describe('GET /me (criterion 2)', () => {
    it("returns the caller's account, an empty profile, and live roles", async () => {
      const user = await loginAs(app, phoneA);

      const res = await app.inject({ method: 'GET', url: `${BASE}/me`, headers: user.authHeader });
      assert.equal(res.statusCode, 200, res.payload);

      const body = res.json();
      assert.equal(body.id, user.userId);
      assert.equal(body.phoneNumber, phoneA);
      assert.equal(body.isPhoneVerified, true);
      assert.equal(body.status, 'ACTIVE');
      assert.deepEqual(body.roles, ['customer'], 'roles are read from user_roles');
      assert.notEqual(body.profile, null, 'profile is never null (doc 02 §2.1)');
      assert.equal(body.profile.firstName, null);
      assert.equal(body.profile.languageCode, 'en');
      assert.equal(body.profile.referralCode, null, 'referral mints this, not USER (USER-OD-2)');
    });

    it('never returns another account, even with a second account present', async () => {
      const a = await loginAs(app, phoneA);
      const b = await loginAs(app, phoneB);
      await patch(a.accessToken, { firstName: 'Aarav' });

      const res = await app.inject({ method: 'GET', url: `${BASE}/me`, headers: b.authHeader });
      const body = res.json();
      assert.equal(body.id, b.userId);
      assert.equal(body.phoneNumber, phoneB);
      assert.equal(body.profile.firstName, null, "B never sees A's profile");
    });

    it('leaks no credential material in the response', async () => {
      const user = await loginAs(app, phoneA);
      const res = await app.inject({ method: 'GET', url: `${BASE}/me`, headers: user.authHeader });
      for (const forbidden of ['passwordHash', 'password_hash', 'deletedAt', 'tokenHash']) {
        assert.ok(!res.payload.includes(forbidden), `${forbidden} must not be exposed`);
      }
    });
  });

  describe('PATCH /me/profile (criterion 3)', () => {
    it('applies only the fields present and leaves the rest untouched', async () => {
      const user = await loginAs(app, phoneA);

      const first = await patch(user.accessToken, { firstName: 'Aarav', lastName: 'Sharma' });
      assert.equal(first.statusCode, 200, first.payload);
      assert.equal(first.json().firstName, 'Aarav');

      const second = await patch(user.accessToken, { languageCode: 'hi' });
      assert.equal(second.statusCode, 200, second.payload);
      const body = second.json();
      assert.equal(body.languageCode, 'hi');
      assert.equal(body.firstName, 'Aarav', 'an omitted key is unchanged, not cleared');
      assert.equal(body.lastName, 'Sharma');
    });

    it('clears a field on an explicit null', async () => {
      const user = await loginAs(app, phoneA);
      await patch(user.accessToken, { firstName: 'Aarav', lastName: 'Sharma' });

      const res = await patch(user.accessToken, { lastName: null });
      assert.equal(res.statusCode, 200, res.payload);
      assert.equal(res.json().lastName, null);
      assert.equal(res.json().firstName, 'Aarav');
    });

    it('round-trips a date of birth as the same calendar date', async () => {
      const user = await loginAs(app, phoneA);
      const res = await patch(user.accessToken, { dateOfBirth: '1994-03-11', gender: 'MALE' });
      assert.equal(res.statusCode, 200, res.payload);
      assert.equal(res.json().dateOfBirth, '1994-03-11', 'no timezone off-by-one (doc 03 §3.1)');

      const stored = await db().client.userProfile.findUnique({ where: { userId: user.userId } });
      assert.equal(stored?.dateOfBirth?.toISOString().slice(0, 10), '1994-03-11');
    });

    it('creates exactly one profile row, never two (USER-INV-1)', async () => {
      const user = await loginAs(app, phoneA);
      await patch(user.accessToken, { firstName: 'Aarav' });
      await patch(user.accessToken, { lastName: 'Sharma' });

      const rows = await db().client.userProfile.findMany({ where: { userId: user.userId } });
      assert.equal(rows.length, 1);
    });

    it('rejects every immutable field by name and changes nothing (USER-INV-5)', async () => {
      const user = await loginAs(app, phoneA);

      const batch = await patch(user.accessToken, {
        phoneNumber: '+919999999999',
        status: 'SUSPENDED',
        roles: ['admin'],
        isEmailVerified: true,
        firstName: 'Aarav',
      });
      assert.equal(batch.statusCode, 400, batch.payload);

      const error = batch.json().error;
      assert.equal(error.code, 'IMMUTABLE_FIELD');
      assert.deepEqual(
        error.details.map((d: { field: string }) => d.field).sort(),
        ['isEmailVerified', 'phoneNumber', 'roles', 'status'],
        'every offending field is named',
      );

      const stored = await db().client.user.findUnique({ where: { id: user.userId } });
      assert.equal(stored?.phoneNumber, phoneA);
      assert.equal(stored?.status, 'ACTIVE');
      assert.equal(stored?.isEmailVerified, false);
      const profile = await db().client.userProfile.findUnique({ where: { userId: user.userId } });
      assert.equal(profile?.firstName, null, 'the writable field was not applied either');
    });

    it('rejects each immutable field individually', async () => {
      const user = await loginAs(app, phoneA);
      for (const field of ['id', 'userId', 'email', 'isPhoneVerified', 'referralCode']) {
        const res = await patch(user.accessToken, { [field]: 'x' });
        assert.equal(res.statusCode, 400, `${field}: ${res.payload}`);
        assert.equal(res.json().error.code, 'IMMUTABLE_FIELD');
        assert.deepEqual(res.json().error.details, [{ field, code: 'IMMUTABLE' }]);
      }
    });

    it('rejects an unknown key rather than silently dropping it', async () => {
      const user = await loginAs(app, phoneA);
      const res = await patch(user.accessToken, { nickname: 'Ari' });
      assert.equal(res.statusCode, 400, res.payload);
      assert.equal(res.json().error.code, 'VALIDATION');
      assert.deepEqual(res.json().error.details, [{ field: 'nickname', code: 'NOT_ALLOWED' }]);
    });

    it('returns a validation error that carries no submitted value (doc 04 §5)', async () => {
      const user = await loginAs(app, phoneA);
      const res = await patch(user.accessToken, { dateOfBirth: '2999-12-25' });
      assert.equal(res.statusCode, 400, res.payload);

      const error = res.json().error;
      assert.equal(error.code, 'VALIDATION');
      assert.deepEqual(error.details, [{ field: 'dateOfBirth', code: 'MUST_BE_PAST' }]);
      assert.ok(!res.payload.includes('2999'), 'the submitted date must not be echoed');
      assert.equal(error.messageKey, 'user.validation');
      assert.ok(error.requestId, 'every error carries the request id (NFR-8)');
    });

    it('treats an empty patch as a no-op that still returns the profile', async () => {
      const user = await loginAs(app, phoneA);
      const res = await patch(user.accessToken, {});
      assert.equal(res.statusCode, 200, res.payload);
      assert.equal(res.json().firstName, null);

      const events = await db().client.outboxEvent.findMany({
        where: { eventType: 'user.profile.updated' },
      });
      assert.equal(events.length, 0, 'no event claims a change that did not happen');
    });
  });

  describe('events (doc 06 §6)', () => {
    it('writes user.profile.updated to the outbox with field names only', async () => {
      const user = await loginAs(app, phoneA);
      await patch(user.accessToken, { firstName: 'Aarav', dateOfBirth: '1994-03-11' });

      const events = await db().client.outboxEvent.findMany({
        where: { eventType: 'user.profile.updated' },
      });
      assert.equal(events.length, 1, 'exactly one event for one change');

      const envelope = events[0]!.payload as unknown as {
        producer: string;
        subject: { userId: string };
        data: { userId: string; changedFields: string[] };
      };
      assert.equal(envelope.producer, 'users', 'the envelope names this module (doc 05 §2)');
      assert.equal(envelope.subject.userId, user.userId);
      assert.deepEqual(envelope.data.changedFields, ['firstName', 'dateOfBirth']);

      const serialized = JSON.stringify(envelope);
      assert.ok(!serialized.includes('Aarav'), 'no name in the event');
      assert.ok(!serialized.includes('1994-03-11'), 'no date of birth in the event');
      assert.ok(!serialized.includes(phoneA), 'no phone number in the event');
    });

    it('emits one event per mutation, not one per field', async () => {
      const user = await loginAs(app, phoneA);
      await patch(user.accessToken, { firstName: 'Aarav' });
      await patch(user.accessToken, { lastName: 'Sharma' });

      const events = await db().client.outboxEvent.findMany({
        where: { eventType: 'user.profile.updated' },
      });
      assert.equal(events.length, 2);
    });
  });
});

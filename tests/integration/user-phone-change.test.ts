import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import {
  FIXED_OTP,
  bootApp,
  db,
  loginAs,
  resetState,
  type LoggedInUser,
} from './helpers/harness.js';

const OWNER = '+919876513001';
const TARGET = '+919876513002';
const HOLDER = '+919876513003';

describe('phone-number change (integration)', () => {
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

  function requestChange(user: LoggedInUser, newPhoneNumber: string) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/users/me/phone/change',
      headers: user.authHeader,
      payload: { newPhoneNumber },
    });
  }

  function verifyChange(
    user: LoggedInUser,
    challengeId: string,
    options: { code?: string; key?: string } = {},
  ) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/users/me/phone/verify',
      headers: { ...user.authHeader, 'idempotency-key': options.key ?? randomUUID() },
      payload: { challengeId, code: options.code ?? FIXED_OTP },
    });
  }

  async function changeNumber(user: LoggedInUser, newPhoneNumber: string) {
    const requested = await requestChange(user, newPhoneNumber);
    assert.equal(requested.statusCode, 202, requested.payload);
    return verifyChange(user, requested.json().challengeId);
  }

  async function events(eventType: string) {
    const rows = await db().client.outboxEvent.findMany({
      where: { eventType },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(
      (row) => row.payload as unknown as { producer: string; data: Record<string, unknown> },
    );
  }

  it('re-binds the number and keeps the identity, its roles, and its history', async () => {
    const user = await loginAs(app, OWNER);
    const before = await db().client.user.findUniqueOrThrow({ where: { id: user.userId } });

    const response = await changeNumber(user, TARGET);
    assert.equal(response.statusCode, 200, response.payload);

    const body = response.json();
    assert.equal(body.user.id, user.userId, 'the account identifier never changes (USER-INV-3)');
    assert.equal(body.user.phoneNumber, TARGET);
    assert.ok(body.accessToken && body.refreshToken, 'a fresh pair for the calling device');

    const after = await db().client.user.findUniqueOrThrow({ where: { id: user.userId } });
    assert.equal(after.phoneNumber, TARGET);
    assert.equal(after.createdAt.getTime(), before.createdAt.getTime(), 'same row, not a new one');

    const roles = await db().client.userRoleAssignment.findMany({
      where: { userId: user.userId },
    });
    assert.ok(roles.length > 0, 'the role granted at registration still points at this account');
  });

  it('sends the code to the NEW number, not the current one (R-USER-10)', async () => {
    const user = await loginAs(app, OWNER);
    const requested = await requestChange(user, TARGET);
    assert.equal(requested.statusCode, 202);

    const challenge = await db().client.otpVerification.findUniqueOrThrow({
      where: { id: requested.json().challengeId },
    });
    assert.equal(challenge.phoneNumber, TARGET, 'proving control of the old number proves nothing');
    assert.equal(challenge.purpose, 'PHONE_CHANGE', 'a login code can never be replayed here');
    assert.equal(challenge.userId, user.userId, 'the challenge is bound to its requester');
  });

  it('leaves the account untouched when the code is wrong', async () => {
    const user = await loginAs(app, OWNER);
    const requested = await requestChange(user, TARGET);
    const response = await verifyChange(user, requested.json().challengeId, { code: '000000' });

    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.code, 'OTP_INVALID');

    assert.equal(response.json().error.messageKey, 'auth.otp_invalid');

    const row = await db().client.user.findUniqueOrThrow({ where: { id: user.userId } });
    assert.equal(row.phoneNumber, OWNER, 'the number is unchanged');
    const sessions = await db().client.userSession.findMany({
      where: { userId: user.userId, revokedAt: null },
    });
    assert.equal(sessions.length, 1, 'and nobody was signed out');
  });

  it('refuses a number another active account holds, before sending anything', async () => {
    await loginAs(app, HOLDER);
    const user = await loginAs(app, OWNER);

    const response = await requestChange(user, HOLDER);
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, 'PHONE_IN_USE');

    const sent = await db().client.otpVerification.findMany({ where: { phoneNumber: HOLDER } });
    assert.equal(sent.length, 1, 'only the holder’s own registration OTP — no new send');
  });

  it('accepts a number a soft-deleted account has freed (R-USER-12)', async () => {
    const holder = await loginAs(app, HOLDER);
    const user = await loginAs(app, OWNER);

    await db().client.user.update({
      where: { id: holder.userId },
      data: { deletedAt: new Date() },
    });

    const response = await changeNumber(user, HOLDER);
    assert.equal(response.statusCode, 200, response.payload);
    assert.equal(response.json().user.phoneNumber, HOLDER);

    const rows = await db().client.user.findMany({ where: { phoneNumber: HOLDER } });
    assert.equal(rows.length, 2);
  });

  it('refuses the number the account already holds', async () => {
    const user = await loginAs(app, OWNER);
    const response = await requestChange(user, OWNER);

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'PHONE_UNCHANGED');
  });

  it('rejects a malformed number as VALIDATION, without a submitted value', async () => {
    const user = await loginAs(app, OWNER);
    const response = await requestChange(user, '9876513002');

    assert.equal(response.statusCode, 400);
    const error = response.json().error;
    assert.equal(error.code, 'VALIDATION');
    assert.deepEqual(error.details, [{ field: 'newPhoneNumber', code: 'INVALID_FORMAT' }]);
    assert.ok(!JSON.stringify(error).includes('9876513002'), 'no submitted value in the body');
  });

  it('signs out every device, including the caller, and re-credentials only the caller', async () => {
    const first = await loginAs(app, OWNER);
    const second = await loginAs(app, OWNER);

    const response = await changeNumber(first, TARGET);
    assert.equal(response.statusCode, 200, response.payload);
    const fresh = response.json().accessToken;

    for (const [label, token] of [
      ['the caller’s original token', first.accessToken],
      ['the other device’s token', second.accessToken],
    ] as const) {
      const probe = await app.inject({
        method: 'GET',
        url: '/api/v1/users/me',
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(probe.statusCode, 401, label);
      assert.equal(probe.json().error.code, 'TOKEN_STALE', label);
    }

    const usable = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: { authorization: `Bearer ${fresh}` },
    });
    assert.equal(usable.statusCode, 200, 'only the pair returned by the change works');
    assert.equal(usable.json().phoneNumber, TARGET);

    const active = await db().client.userSession.findMany({
      where: { userId: first.userId, revokedAt: null },
    });
    assert.equal(active.length, 1, 'exactly one device holds credentials afterwards');
  });

  it('audits the change with masked numbers and a revocation count that matches', async () => {
    const user = await loginAs(app, OWNER);
    await loginAs(app, OWNER);
    assert.equal((await changeNumber(user, TARGET)).statusCode, 200);

    const [changed] = await events('user.phone.changed');
    assert.ok(changed, 'the change is never silent (R-USER-14)');
    assert.equal(changed.producer, 'users');
    assert.deepEqual(changed.data, {
      userId: user.userId,
      oldPhoneMasked: '+9198765•••01',
      newPhoneMasked: '+9198765•••02',
      sessionsRevoked: 2,
    });

    const revoked = await events('auth.session.revoked');
    const forThisChange = revoked.filter((event) => event.data.reason === 'phone_changed');
    assert.equal(forThisChange.length, changed.data.sessionsRevoked);
  });

  it('emits AUTH’s account.recovery.completed rather than a user.* duplicate', async () => {
    const user = await loginAs(app, OWNER);
    assert.equal((await changeNumber(user, TARGET)).statusCode, 200);

    const [recovery] = await events('account.recovery.completed');
    assert.ok(recovery, 'this flow is the trigger AUTH defined the event for (USER-OD-4)');
    assert.equal(recovery.producer, 'auth');
    assert.deepEqual(recovery.data, { userId: user.userId, actor: 'self', changedPhone: true });

    const all = await db().client.outboxEvent.findMany();
    assert.equal(
      all.filter((row) => row.eventType.startsWith('user.account.recovery')).length,
      0,
      'USER invents no near-duplicate of it',
    );
  });

  it('keeps every phone number out of every payload it writes (doc 05 §5)', async () => {
    const user = await loginAs(app, OWNER);
    assert.equal((await changeNumber(user, TARGET)).statusCode, 200);

    const rows = await db().client.outboxEvent.findMany({
      where: { eventType: { startsWith: 'user.' } },
    });
    const payloads = JSON.stringify(rows.map((row) => row.payload));
    assert.ok(!payloads.includes(OWNER), 'no unmasked old number');
    assert.ok(!payloads.includes(TARGET), 'no unmasked new number');
    assert.ok(payloads.includes('•••'), 'the masked forms are there');
  });

  it('replays a retried key instead of revoking the session it just issued', async () => {
    const user = await loginAs(app, OWNER);
    const challengeId = (await requestChange(user, TARGET)).json().challengeId;
    const key = randomUUID();

    const first = await verifyChange(user, challengeId, { key });
    assert.equal(first.statusCode, 200, first.payload);

    const retry = await app.inject({
      method: 'POST',
      url: '/api/v1/users/me/phone/verify',
      headers: {
        authorization: `Bearer ${first.json().accessToken}`,
        'idempotency-key': key,
      },
      payload: { challengeId, code: FIXED_OTP },
    });
    assert.equal(retry.statusCode, 200, retry.payload);
    assert.deepEqual(retry.json(), first.json(), 'the stored response, byte for byte');

    const active = await db().client.userSession.findMany({
      where: { userId: user.userId, revokedAt: null },
    });
    assert.equal(active.length, 1, 'the retry did not revoke the session the first call issued');
  });

  it('stops a retry that still carries the pre-change token at the gate', async () => {
    const user = await loginAs(app, OWNER);
    const challengeId = (await requestChange(user, TARGET)).json().challengeId;
    const key = randomUUID();
    assert.equal((await verifyChange(user, challengeId, { key })).statusCode, 200);

    const retry = await verifyChange(user, challengeId, { key });
    assert.equal(retry.statusCode, 401);
    assert.equal(retry.json().error.code, 'TOKEN_STALE');

    const active = await db().client.userSession.findMany({
      where: { userId: user.userId, revokedAt: null },
    });
    assert.equal(active.length, 1, 'no second revocation storm either way');
    const row = await db().client.user.findUniqueOrThrow({ where: { id: user.userId } });
    assert.equal(row.phoneNumber, TARGET, 'and no second change');
  });

  it('caps change requests per account, independently of AUTH’s per-phone limits', async () => {
    const user = await loginAs(app, OWNER);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const allowed = await requestChange(user, TARGET);
      assert.equal(allowed.statusCode, 202, `attempt ${attempt + 1}: ${allowed.payload}`);
    }

    const blocked = await requestChange(user, TARGET);
    assert.equal(blocked.statusCode, 429);
    assert.equal(blocked.json().error.code, 'RATE_LIMITED');
    assert.ok(blocked.headers['retry-after'], 'the client is told how long to wait');
  });

  it('will not let one account redeem another’s challenge', async () => {
    const user = await loginAs(app, OWNER);
    const stranger = await loginAs(app, HOLDER);

    const requested = await requestChange(user, TARGET);
    assert.equal(requested.statusCode, 202);

    const stolen = await verifyChange(stranger, requested.json().challengeId);
    assert.equal(stolen.statusCode, 401);
    assert.equal(stolen.json().error.code, 'OTP_INVALID');

    const row = await db().client.user.findUniqueOrThrow({ where: { id: stranger.userId } });
    assert.equal(row.phoneNumber, HOLDER, 'the stranger’s number is untouched');
  });

  it('lets the database settle a race the application re-check cannot see', async () => {
    const holder = await loginAs(app, HOLDER);
    const user = await loginAs(app, OWNER);

    await assert.rejects(
      db().client.user.update({ where: { id: user.userId }, data: { phoneNumber: HOLDER } }),
      /Unique constraint|uq_users_phone_active/i,
    );
    const row = await db().client.user.findUniqueOrThrow({ where: { id: holder.userId } });
    assert.equal(row.phoneNumber, HOLDER);
  });

  it('refuses a verify with no Idempotency-Key, since it would revoke on retry', async () => {
    const user = await loginAs(app, OWNER);
    const requested = await requestChange(user, TARGET);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/users/me/phone/verify',
      headers: user.authHeader,
      payload: { challengeId: requested.json().challengeId, code: FIXED_OTP },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'VALIDATION');
  });

  it('is closed to unauthenticated callers, like every route in this module', async () => {
    for (const url of ['/api/v1/users/me/phone/change', '/api/v1/users/me/phone/verify']) {
      const response = await app.inject({ method: 'POST', url, payload: {} });
      assert.equal(response.statusCode, 401, url);
      assert.equal(response.json().error.code, 'TOKEN_INVALID', url);
    }
  });
});

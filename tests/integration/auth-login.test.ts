import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, resetState, FIXED_OTP } from './helpers/harness.js';
import { container } from '../../src/core/di.js';
import type { UserRepository } from '../../src/modules/auth/repositories/user.repository.js';

const BASE = '/api/v1/auth';

describe('auth login flow (integration)', () => {
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

  const phone = '+919876500001';

  async function send(): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: `${BASE}/otp/send`,
      payload: { phoneNumber: phone },
    });
    assert.equal(res.statusCode, 200, res.payload);
    return res.json().challengeId as string;
  }

  async function verify(challengeId: string, key: string = randomUUID()) {
    return app.inject({
      method: 'POST',
      url: `${BASE}/otp/verify`,
      headers: { 'idempotency-key': key },
      payload: { phoneNumber: phone, code: FIXED_OTP, challengeId },
    });
  }

  it('first verify registers the account, grants customer, opens a session, records events', async () => {
    const res = await verify(await send());
    assert.equal(res.statusCode, 200, res.payload);

    const body = res.json();
    assert.equal(body.user.isNew, true);
    assert.deepEqual(body.user.roles, ['customer']);
    assert.equal(body.user.status, 'ACTIVE');
    assert.ok(body.accessToken && body.refreshToken, 'a token pair is issued');

    const users = await db().client.user.findMany();
    assert.equal(users.length, 1);
    assert.equal(users[0]?.isPhoneVerified, true);

    const sessions = await db().client.userSession.findMany();
    assert.equal(sessions.length, 1);

    const refresh = await db().client.refreshToken.findMany();
    assert.equal(refresh.length, 1);

    const types = (await db().client.outboxEvent.findMany()).map((o) => o.eventType);
    for (const expected of [
      'auth.otp.verified',
      'auth.login.succeeded',
      'auth.session.created',
      'account.role.granted',
    ]) {
      assert.ok(
        types.includes(expected),
        `expected outbox event ${expected}, got ${types.join(',')}`,
      );
    }
  });

  it('returning verify opens a new session without duplicating the account', async () => {
    await verify(await send());
    const res2 = await verify(await send());
    assert.equal(res2.statusCode, 200, res2.payload);
    assert.equal(res2.json().user.isNew, false);

    assert.equal((await db().client.user.findMany()).length, 1, 'no duplicate account');
    const active = await db().client.userSession.findMany({ where: { revokedAt: null } });
    assert.equal(active.length, 2, 'two concurrent sessions');
  });

  it('idempotent verify replays the stored token set (no second session, OTP not re-consumed)', async () => {
    const key = randomUUID();
    const challengeId = await send();
    const v1 = await verify(challengeId, key);
    const v2 = await verify(challengeId, key);

    assert.equal(v1.statusCode, 200, v1.payload);
    assert.equal(v2.statusCode, 200, v2.payload);
    assert.equal(v1.json().accessToken, v2.json().accessToken, 'replayed, not re-issued');
    assert.equal((await db().client.userSession.findMany()).length, 1, 'exactly one session');
  });

  it('rejects a wrong code with OTP_INVALID (401) and no account/session', async () => {
    const challengeId = await send();
    const res = await app.inject({
      method: 'POST',
      url: `${BASE}/otp/verify`,
      headers: { 'idempotency-key': randomUUID() },
      payload: { phoneNumber: phone, code: '000000', challengeId },
    });
    assert.equal(res.statusCode, 401, res.payload);
    assert.equal(res.json().error.code, 'OTP_INVALID');
    assert.equal((await db().client.userSession.findMany()).length, 0);
  });

  it('rolls the whole login back when a write inside the transaction fails (atomicity)', async () => {
    const repo = container.resolve<UserRepository>('userRepository');
    const original = repo.updateLastLoginAt.bind(repo);
    repo.updateLastLoginAt = async () => {
      throw new Error('injected failure mid-transaction');
    };
    try {
      const res = await verify(await send());
      assert.equal(res.statusCode, 500, res.payload);
    } finally {
      repo.updateLastLoginAt = original;
    }

    assert.equal((await db().client.user.findMany()).length, 0, 'user create rolled back');
    assert.equal((await db().client.userSession.findMany()).length, 0, 'session rolled back');
    assert.equal(
      (await db().client.refreshToken.findMany()).length,
      0,
      'refresh token rolled back',
    );
    assert.equal(
      (await db().client.userRoleAssignment.findMany()).length,
      0,
      'role grant rolled back',
    );
    assert.equal(
      (await db().client.outboxEvent.findMany()).length,
      0,
      'no audit events without their state change',
    );
  });
});

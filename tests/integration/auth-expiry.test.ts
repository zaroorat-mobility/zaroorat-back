import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it, mock } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { FIXED_OTP, bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { container } from '../../src/core/di.js';
import { redis } from '../../src/core/cache/client.js';
import { RedisKeys } from '../../src/core/cache/keys.js';
import type { AuthService } from '../../src/modules/auth/services/auth.service.js';
import type { SessionService } from '../../src/modules/auth/services/session/session.service.js';

const PHONE = '+919876520001';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

describe('expiry paths (integration)', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await bootApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(async () => {
    mock.timers.reset();
    await resetState();
  });

  async function atOffset<T>(offsetMs: number, body: () => Promise<T>): Promise<T> {
    mock.timers.enable({ apis: ['Date'], now: new Date(Date.now() + offsetMs) });
    try {
      return await body();
    } finally {
      mock.timers.reset();
    }
  }

  function probe(accessToken: string) {
    return app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  describe('the access token', () => {
    it('still works a minute before its TTL runs out', async () => {
      const user = await loginAs(app, PHONE);
      const response = await atOffset(14 * MINUTE, () => probe(user.accessToken));
      assert.equal(response.statusCode, 200, response.payload);
    });

    it('is refused a minute after it', async () => {
      const user = await loginAs(app, PHONE);
      const response = await atOffset(16 * MINUTE, () => probe(user.accessToken));

      assert.equal(response.statusCode, 401);

      assert.equal(response.json().error.code, 'TOKEN_INVALID');
    });

    it('is refused on the exact second it expires, not one later', async () => {
      const user = await loginAs(app, PHONE);

      const response = await atOffset(15 * MINUTE, () => probe(user.accessToken));
      assert.equal(response.statusCode, 401);
    });
  });

  describe('the refresh token', () => {
    function rotate(refreshToken: string) {
      return app.inject({
        method: 'POST',
        url: '/api/v1/auth/token/refresh',
        headers: { 'idempotency-key': randomUUID() },
        payload: { refreshToken },
      });
    }

    it('rotates while it is live', async () => {
      const user = await loginAs(app, PHONE);
      const response = await atOffset(29 * DAY, () => rotate(user.refreshToken));
      assert.equal(response.statusCode, 200, response.payload);
    });

    it('is refused once its TTL passes, and issues nothing', async () => {
      const user = await loginAs(app, PHONE);
      const response = await atOffset(31 * DAY, () => rotate(user.refreshToken));

      assert.equal(response.statusCode, 401);
      assert.equal(response.json().error.code, 'TOKEN_INVALID');

      const tokens = await db().client.refreshToken.findMany({ where: { userId: user.userId } });
      assert.equal(tokens.length, 1, 'no rotation happened');
      assert.equal(tokens[0]!.revokedAt, null, 'and the family was not revoked');
    });
  });

  describe('the session', () => {
    it('drops out of the active set once it expires', async () => {
      const user = await loginAs(app, PHONE);
      const sessions = container.resolve<SessionService>('sessionService');
      assert.equal((await sessions.listSessions(user.userId)).length, 1);

      const live = await atOffset(31 * DAY, () => sessions.listSessions(user.userId));
      assert.equal(live.length, 0);

      const row = await db().client.userSession.findFirstOrThrow({
        where: { userId: user.userId },
      });
      assert.equal(row.revokedAt, null, 'expired is not revoked — nothing rewrote the row');
    });
  });

  describe('a scoped role', () => {
    it('is held until its expiry and gone after it', async () => {
      const user = await loginAs(app, PHONE);
      const auth = container.resolve<AuthService>('authService');
      await auth.grantRole(user.userId, 'support', {
        expiresAt: new Date(Date.now() + DAY),
      });

      const during = await atOffset(12 * 60 * MINUTE, async () => {
        const session = await loginAs(app, PHONE);
        return probe(session.accessToken);
      });
      assert.deepEqual([...during.json().roles].sort(), ['customer', 'support']);

      const after = await atOffset(2 * DAY, async () => {
        const session = await loginAs(app, PHONE);
        return probe(session.accessToken);
      });
      assert.deepEqual(after.json().roles, ['customer'], 'the scoped role lapsed on its own');

      const assignment = await db().client.userRoleAssignment.findFirstOrThrow({
        where: { userId: user.userId, role: { slug: 'support' } },
      });
      assert.equal(assignment.revokedAt, null);
    });
  });

  describe('the OTP challenge', () => {
    it('reports OTP_EXPIRED once the challenge row has aged out', async () => {
      const sent = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/send',
        payload: { phoneNumber: PHONE },
      });
      const challengeId = sent.json().challengeId as string;

      await redis.del(RedisKeys.otp('LOGIN', PHONE));

      const response = await atOffset(6 * MINUTE, () =>
        app.inject({
          method: 'POST',
          url: '/api/v1/auth/otp/verify',
          headers: { 'idempotency-key': randomUUID() },
          payload: { phoneNumber: PHONE, code: FIXED_OTP, challengeId },
        }),
      );

      assert.equal(response.statusCode, 410, response.payload);
      assert.equal(response.json().error.code, 'OTP_EXPIRED');

      const attempt = await db().client.otpVerification.findUniqueOrThrow({
        where: { id: challengeId },
      });
      assert.equal(attempt.outcome, 'expired');
      assert.equal(
        await db().client.user.count({ where: { phoneNumber: PHONE } }),
        0,
        'and no account was opened',
      );
    });

    it('does not count an expiry against the lockout', async () => {
      const sent = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/send',
        payload: { phoneNumber: PHONE },
      });
      await redis.del(RedisKeys.otp('LOGIN', PHONE));

      await atOffset(6 * MINUTE, () =>
        app.inject({
          method: 'POST',
          url: '/api/v1/auth/otp/verify',
          headers: { 'idempotency-key': randomUUID() },
          payload: { phoneNumber: PHONE, code: FIXED_OTP, challengeId: sent.json().challengeId },
        }),
      );

      const attempts = await redis.get(RedisKeys.otpAttempts(PHONE));
      assert.equal(attempts, null, 'no failed-attempt counter was started');
    });
  });
});

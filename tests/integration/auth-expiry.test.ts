import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it, mock } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { FIXED_OTP, bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { container } from '../../src/core/di.js';
import { redis } from '../../src/core/cache/client.js';
import { RedisKeys } from '../../src/core/cache/keys.js';
import type { AuthService } from '../../src/modules/auth/auth.service.js';
import type { SessionService } from '../../src/modules/auth/session/session.service.js';

const PHONE = '+919876520001';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/**
 * Expiry paths, driven by an injected clock (doc 07 §2: "Time is injected, never
 * `sleep`").
 *
 * Every TTL the application itself judges — access-token `exp`, refresh-token
 * `expires_at`, session `expires_at`, a scoped role's `expires_at`, and an OTP
 * challenge row — is a `Date.now()` comparison in our own code, so `node:test`'s
 * timer mock reaches all of them with no production seam to add and nothing to
 * wait for.
 *
 * **Only `Date` is faked, never `setTimeout`.** ioredis and Prisma drive their
 * connection handling off real timers; freezing those deadlocks the suite rather
 * than failing it.
 *
 * What this cannot cover is stated plainly rather than faked: TTLs enforced *by
 * Redis* — the OTP secret and the verify lockout — expire on the server's clock,
 * which no in-process mock moves. Where a test needs that state gone it deletes
 * the key, which is precisely what the TTL does, and says so.
 */
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

  /** Run `body` with the process clock frozen `offsetMs` from now. */
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

  // ── Access tokens (15 min) ────────────────────────────────────────────────

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
      // Expiry is indistinguishable from a bad signature by design: both are
      // "this credential is not usable", and splitting them tells an attacker
      // which half of the token to work on (doc 05 §4).
      assert.equal(response.json().error.code, 'TOKEN_INVALID');
    });

    it('is refused on the exact second it expires, not one later', async () => {
      const user = await loginAs(app, PHONE);
      // `exp` is compared with `<=`, so the boundary second is already gone.
      const response = await atOffset(15 * MINUTE, () => probe(user.accessToken));
      assert.equal(response.statusCode, 401);
    });
  });

  // ── Refresh tokens and sessions (30 days) ─────────────────────────────────

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

      // An expired token must not be treated as reuse: the family is intact and
      // nobody was signed out over an ordinary lapse.
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

      // The active-session query bounds on `expires_at > now`, so this is the
      // same judgement the concurrency cap makes when it counts live sessions.
      const live = await atOffset(31 * DAY, () => sessions.listSessions(user.userId));
      assert.equal(live.length, 0);

      const row = await db().client.userSession.findFirstOrThrow({
        where: { userId: user.userId },
      });
      assert.equal(row.revokedAt, null, 'expired is not revoked — nothing rewrote the row');
    });
  });

  // ── Scoped roles ──────────────────────────────────────────────────────────

  describe('a scoped role', () => {
    it('is held until its expiry and gone after it', async () => {
      const user = await loginAs(app, PHONE);
      const auth = container.resolve<AuthService>('authService');
      await auth.grantRole(user.userId, 'support', {
        expiresAt: new Date(Date.now() + DAY),
      });

      // Logging in *at* each instant is what proves it end to end: the claim and
      // GET /me are both derived from the same expiry-aware read.
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

      // Lapsing is not revoking: the assignment is still there, unrevoked.
      const assignment = await db().client.userRoleAssignment.findFirstOrThrow({
        where: { userId: user.userId, role: { slug: 'support' } },
      });
      assert.equal(assignment.revokedAt, null);
    });
  });

  // ── The OTP challenge ─────────────────────────────────────────────────────

  describe('the OTP challenge', () => {
    it('reports OTP_EXPIRED once the challenge row has aged out', async () => {
      const sent = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/send',
        payload: { phoneNumber: PHONE },
      });
      const challengeId = sent.json().challengeId as string;

      // Redis expires the secret on its own clock, which no in-process mock can
      // move, so the key is deleted instead — exactly what its 5-minute TTL does.
      // The clock then carries the challenge *row* past its expiry, which is the
      // branch under test: a client holding a stale challenge is told to resend
      // rather than being told its code was wrong.
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

      // A code that timed out is not a wrong code; charging it to the lockout
      // counter would punish a slow user for the platform's own TTL.
      const attempts = await redis.get(RedisKeys.otpAttempts(PHONE));
      assert.equal(attempts, null, 'no failed-attempt counter was started');
    });
  });
});

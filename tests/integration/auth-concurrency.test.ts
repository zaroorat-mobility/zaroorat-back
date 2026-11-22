import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { LightMyRequestResponse } from 'fastify';

import { FIXED_OTP, bootApp, db, resetState } from './helpers/harness.js';

const PHONE = '+919876517001';

describe('auth concurrency invariants (integration)', () => {
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

  async function sendOtp(phoneNumber: string): Promise<string> {
    const sent = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/send',
      payload: { phoneNumber },
    });
    assert.equal(sent.statusCode, 200, sent.payload);
    return sent.json().challengeId;
  }

  function verifyConcurrently(
    phoneNumber: string,
    challengeId: string,
    count = 2,
  ): Promise<LightMyRequestResponse[]> {
    return Promise.all(
      Array.from({ length: count }, () =>
        app.inject({
          method: 'POST',
          url: '/api/v1/auth/otp/verify',
          headers: { 'idempotency-key': randomUUID() },
          payload: { phoneNumber, code: FIXED_OTP, challengeId },
        }),
      ),
    );
  }

  function activeAccounts(phoneNumber: string) {
    return db().client.user.findMany({ where: { phoneNumber, deletedAt: null } });
  }

  describe('AUTH-INV-1 — exactly one active account per phone number', () => {
    it('admits one of two simultaneous first-time registrations, and only one', async () => {
      const challengeId = await sendOtp(PHONE);
      const responses = await verifyConcurrently(PHONE, challengeId);

      const created = responses.filter((r) => r.statusCode === 200);
      assert.equal(created.length, 1, responses.map((r) => r.payload).join('\n'));

      const rows = await activeAccounts(PHONE);
      assert.equal(rows.length, 1, 'exactly one active users row');
      assert.equal(created[0]!.json().user.id, rows[0]!.id, 'and it is the one that answered 200');
      assert.equal(created[0]!.json().user.isNew, true, 'reported as a registration');
    });

    it('lets the partial index settle it, not the application', async () => {
      const insert = () =>
        db().client.user.create({ data: { phoneNumber: PHONE, status: 'ACTIVE' } });
      const outcomes = await Promise.allSettled([insert(), insert()]);

      const won = outcomes.filter((o) => o.status === 'fulfilled');
      const lost = outcomes.filter((o) => o.status === 'rejected');
      assert.equal(won.length, 1, 'one insert committed');
      assert.equal(lost.length, 1, 'the other was rejected by the database');
      assert.match(
        String((lost[0] as PromiseRejectedResult).reason),
        /Unique constraint|uq_users_phone_active/i,
      );
      assert.equal((await activeAccounts(PHONE)).length, 1);
    });

    it('frees the number for a brand-new account once the old row is soft-deleted', async () => {
      const first = await verifyConcurrently(PHONE, await sendOtp(PHONE), 1);
      const originalId = first[0]!.json().user.id;

      await db().client.user.update({
        where: { id: originalId },
        data: { deletedAt: new Date() },
      });
      await resetOtpState();

      const second = await verifyConcurrently(PHONE, await sendOtp(PHONE), 1);
      assert.equal(second[0]!.statusCode, 200, second[0]!.payload);
      const returned = second[0]!.json().user;
      assert.notEqual(returned.id, originalId, 'a new identity, not the old one revived');
      assert.equal(returned.isNew, true);

      assert.equal((await activeAccounts(PHONE)).length, 1, 'still one live row');
      assert.equal(
        await db().client.user.count({ where: { phoneNumber: PHONE } }),
        2,
        'and the soft-deleted one is still there — records are never removed',
      );
    });

    it('holds under more than two callers', async () => {
      const challengeId = await sendOtp(PHONE);
      const responses = await verifyConcurrently(PHONE, challengeId, 6);

      assert.equal(responses.filter((r) => r.statusCode === 200).length, 1);
      assert.equal((await activeAccounts(PHONE)).length, 1);
    });
  });

  describe('AUTH-INV-2 — an OTP is consumed exactly once', () => {
    it('lets exactly one of two simultaneous verifies through', async () => {
      const challengeId = await sendOtp(PHONE);
      const [a, b] = await verifyConcurrently(PHONE, challengeId);

      const codes = [a!.statusCode, b!.statusCode].sort();
      assert.deepEqual(codes, [200, 401], `${a!.payload}\n${b!.payload}`);

      const loser = [a!, b!].find((r) => r.statusCode === 401)!;
      assert.equal(loser.json().error.code, 'OTP_INVALID');
    });

    it('opens exactly one session and one refresh token', async () => {
      const challengeId = await sendOtp(PHONE);
      const responses = await verifyConcurrently(PHONE, challengeId);
      const winner = responses.find((r) => r.statusCode === 200)!.json();

      const [sessions, refreshTokens] = await Promise.all([
        db().client.userSession.findMany({ where: { userId: winner.user.id } }),
        db().client.refreshToken.findMany({ where: { userId: winner.user.id } }),
      ]);
      assert.equal(sessions.length, 1, 'a duplicated OTP must not duplicate the session');
      assert.equal(refreshTokens.length, 1);
      assert.equal(sessions[0]!.revokedAt, null, 'and the one session is live');
    });

    it('leaves the code spent, so neither caller can retry it', async () => {
      const challengeId = await sendOtp(PHONE);
      await verifyConcurrently(PHONE, challengeId);

      const retry = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/verify',
        headers: { 'idempotency-key': randomUUID() },
        payload: { phoneNumber: PHONE, code: FIXED_OTP, challengeId },
      });
      assert.equal(retry.statusCode, 401, retry.payload);
      assert.equal(retry.json().error.code, 'OTP_INVALID');
      assert.equal((await activeAccounts(PHONE)).length, 1, 'and still one account');
    });

    it('files the challenge as verified, whichever caller finishes last', async () => {
      const challengeId = await sendOtp(PHONE);
      await verifyConcurrently(PHONE, challengeId);

      const attempt = await db().client.otpVerification.findUniqueOrThrow({
        where: { id: challengeId },
      });

      assert.equal(attempt.outcome, 'verified');
      assert.notEqual(attempt.verifiedAt, null, 'and the two agree');
    });

    it('announces one login, not two', async () => {
      const challengeId = await sendOtp(PHONE);
      await verifyConcurrently(PHONE, challengeId);

      const succeeded = await db().client.outboxEvent.count({
        where: { eventType: 'auth.login.succeeded' },
      });
      const created = await db().client.outboxEvent.count({
        where: { eventType: 'auth.session.created' },
      });
      assert.equal(succeeded, 1, 'one session opened, one audit trail');
      assert.equal(created, 1);
    });

    it('holds under more than two callers', async () => {
      const challengeId = await sendOtp(PHONE);
      const responses = await verifyConcurrently(PHONE, challengeId, 6);

      assert.equal(responses.filter((r) => r.statusCode === 200).length, 1);

      const refused = responses.filter((r) => r.statusCode !== 200);
      assert.equal(refused.length, 5, 'every other caller is refused');
      for (const response of refused) {
        assert.ok([401, 429].includes(response.statusCode), String(response.statusCode));
        assert.ok(['OTP_INVALID', 'OTP_LOCKED'].includes(response.json().error.code));
      }
      assert.equal((await activeAccounts(PHONE)).length, 1);
    });
  });

  async function loginForRefreshToken(phoneNumber: string): Promise<string> {
    const challengeId = await sendOtp(phoneNumber);
    const verified = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/verify',
      headers: { 'idempotency-key': randomUUID() },
      payload: { phoneNumber, code: FIXED_OTP, challengeId },
    });
    assert.equal(verified.statusCode, 200, verified.payload);
    return verified.json().refreshToken as string;
  }

  function refreshConcurrently(refreshToken: string, count = 2): Promise<LightMyRequestResponse[]> {
    return Promise.all(
      Array.from({ length: count }, () =>
        app.inject({
          method: 'POST',
          url: '/api/v1/auth/token/refresh',
          headers: { 'idempotency-key': randomUUID() },
          payload: { refreshToken },
        }),
      ),
    );
  }

  describe('AUTH-INV-5 — a refresh token rotates exactly once', () => {
    function liveTokens(userId: string) {
      return db().client.refreshToken.findMany({ where: { userId, revokedAt: null } });
    }

    async function userIdFor(phoneNumber: string): Promise<string> {
      const [user] = await activeAccounts(phoneNumber);
      assert.ok(user, 'the account exists');
      return user.id;
    }

    it('lets exactly one of two simultaneous refreshes through', async () => {
      const refreshToken = await loginForRefreshToken(PHONE);

      const responses = await refreshConcurrently(refreshToken);
      const ok = responses.filter((r) => r.statusCode === 200);
      const refused = responses.filter((r) => r.statusCode !== 200);

      assert.equal(ok.length, 1, responses.map((r) => r.payload).join('\n'));
      assert.equal(refused.length, 1);
      assert.equal(refused[0]?.statusCode, 401);
      assert.equal(refused[0]?.json().error.code, 'TOKEN_REUSE');
    });

    it('leaves exactly one live successor, never two', async () => {
      const refreshToken = await loginForRefreshToken(PHONE);
      const userId = await userIdFor(PHONE);

      await refreshConcurrently(refreshToken);

      const live = await liveTokens(userId);
      assert.equal(
        live.length,
        0,
        'the race is treated as reuse, so the whole family is revoked — not two live tokens',
      );
    });

    it('holds under more than two callers', async () => {
      const refreshToken = await loginForRefreshToken(PHONE);
      const userId = await userIdFor(PHONE);

      const responses = await refreshConcurrently(refreshToken, 6);
      assert.equal(responses.filter((r) => r.statusCode === 200).length, 1);
      assert.ok((await liveTokens(userId)).length <= 1);
    });

    it('revokes the family and bumps the epoch, per the existing reuse policy', async () => {
      const refreshToken = await loginForRefreshToken(PHONE);
      const userId = await userIdFor(PHONE);

      await refreshConcurrently(refreshToken);

      const reuse = await db().client.outboxEvent.findMany({
        where: { eventType: 'auth.refresh.reuse_detected' },
      });
      assert.equal(reuse.length, 1, 'the race is audited as reuse, exactly like a replay');

      const sessions = await db().client.userSession.findMany({ where: { userId } });
      assert.ok(sessions.length >= 1, 'the session row survives for the audit trail');
      const stillLive = await db().client.refreshToken.findMany({
        where: { userId, revokedAt: null },
      });
      assert.equal(stillLive.length, 0);
    });

    it('replays rather than races when the retry carries the same key', async () => {
      const refreshToken = await loginForRefreshToken(PHONE);
      const key = randomUUID();

      const responses = await Promise.all(
        Array.from({ length: 2 }, () =>
          app.inject({
            method: 'POST',
            url: '/api/v1/auth/token/refresh',
            headers: { 'idempotency-key': key },
            payload: { refreshToken },
          }),
        ),
      );

      const ok = responses.filter((r) => r.statusCode === 200);
      assert.ok(ok.length >= 1, 'at least one caller gets the real answer');

      for (const response of responses) {
        assert.ok(
          [200, 409].includes(response.statusCode),
          `a same-key retry must not be treated as reuse (got ${response.statusCode})`,
        );
      }
      if (ok.length === 2) {
        assert.equal(
          ok[0]?.json().refreshToken,
          ok[1]?.json().refreshToken,
          'a replay returns the stored response, not a second rotation',
        );
      }

      assert.equal(
        await db().client.outboxEvent.count({
          where: { eventType: 'auth.refresh.reuse_detected' },
        }),
        0,
        'and nothing was audited as reuse',
      );
    });

    it('still detects a genuine replay after the rotation has settled', async () => {
      const refreshToken = await loginForRefreshToken(PHONE);

      const first = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/token/refresh',
        headers: { 'idempotency-key': randomUUID() },
        payload: { refreshToken },
      });
      assert.equal(first.statusCode, 200, first.payload);

      const replay = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/token/refresh',
        headers: { 'idempotency-key': randomUUID() },
        payload: { refreshToken },
      });
      assert.equal(replay.statusCode, 401);
      assert.equal(replay.json().error.code, 'TOKEN_REUSE');
    });
  });

  async function resetOtpState(): Promise<void> {
    const { redis } = await import('../../src/core/cache/client.js');
    const keys = await redis.keys('otp:*');
    if (keys.length > 0) await redis.del(...keys);
  }
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { LightMyRequestResponse } from 'fastify';

import { FIXED_OTP, bootApp, db, resetState } from './helpers/harness.js';

const PHONE = '+919876517001';

/**
 * The two AUTH invariants doc 07 §4 marks **integration (concurrent)**.
 *
 * Both are invisible to a sequential suite: a read-then-write account check and a
 * non-atomic OTP consume pass every test in `auth-login.test.ts` and fail only
 * when two callers arrive at once. That is the whole reason these rows exist
 * separately, and why they were the last gap in the AUTH suite.
 *
 * `Promise.all` over `app.inject` gives real overlap — Fastify handles each
 * injection independently, so the two requests interleave on the same Redis
 * connection pool and the same Postgres pool a real pair of clients would.
 */
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

  /** Request an OTP and return the challenge the client would hold. */
  async function sendOtp(phoneNumber: string): Promise<string> {
    const sent = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/send',
      payload: { phoneNumber },
    });
    assert.equal(sent.statusCode, 200, sent.payload);
    return sent.json().challengeId;
  }

  /**
   * Fire `count` verifies of the same code at once.
   *
   * Each carries its **own** `Idempotency-Key`. Sharing one would exercise the
   * stored-response replay instead — a different guarantee, already covered in
   * `auth-login.test.ts`, and it would hide the race these tests exist to find.
   */
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

  /** Live (non-soft-deleted) rows holding a phone number. */
  function activeAccounts(phoneNumber: string) {
    return db().client.user.findMany({ where: { phoneNumber, deletedAt: null } });
  }

  // ── AUTH-INV-1 ────────────────────────────────────────────────────────────

  describe('AUTH-INV-1 — exactly one active account per phone number', () => {
    it('admits one of two simultaneous first-time registrations, and only one', async () => {
      const challengeId = await sendOtp(PHONE);
      const responses = await verifyConcurrently(PHONE, challengeId);

      const created = responses.filter((r) => r.statusCode === 200);
      assert.equal(created.length, 1, responses.map((r) => r.payload).join('\n'));

      // The API response and the database must agree — a second row that nobody
      // was told about is the failure mode this invariant exists to prevent.
      const rows = await activeAccounts(PHONE);
      assert.equal(rows.length, 1, 'exactly one active users row');
      assert.equal(created[0]!.json().user.id, rows[0]!.id, 'and it is the one that answered 200');
      assert.equal(created[0]!.json().user.isNew, true, 'reported as a registration');
    });

    it('lets the partial index settle it, not the application', async () => {
      // Bypassing the service entirely: two inserts racing for the same number.
      // `uq_users_phone_active` is the enforcement (auth doc 03 §4); the
      // application check is a courtesy for the error message, and a check that
      // runs before a write can always be overtaken by another writer.
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

      // The index is partial on `deleted_at IS NULL`, so a soft delete releases
      // the number without removing the history that hangs off the old identity.
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

  // ── AUTH-INV-2 ────────────────────────────────────────────────────────────

  describe('AUTH-INV-2 — an OTP is consumed exactly once', () => {
    it('lets exactly one of two simultaneous verifies through', async () => {
      const challengeId = await sendOtp(PHONE);
      const [a, b] = await verifyConcurrently(PHONE, challengeId);

      const codes = [a!.statusCode, b!.statusCode].sort();
      assert.deepEqual(codes, [200, 401], `${a!.payload}\n${b!.payload}`);

      // The loser gets AUTH's merged OTP failure, not a distinct "already used"
      // code — distinguishing them would be an oracle (doc 05 §3.2).
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
      // Winner and losers write to the same challenge row. Before the conditional
      // update in `updateOutcome`, a loser landing last filed a login that really
      // succeeded as `failed` — while leaving `verified_at` set, so the row
      // contradicted itself and the fraud reads disagreed with the outcome column.
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
      // The other five are refused, but not all with the same code: five failed
      // attempts is the lockout threshold, so the last of them legitimately comes
      // back `429 OTP_LOCKED` instead of `401 OTP_INVALID`. Which caller crosses
      // it is a race, so the assertion is on the set, not the split.
      const refused = responses.filter((r) => r.statusCode !== 200);
      assert.equal(refused.length, 5, 'every other caller is refused');
      for (const response of refused) {
        assert.ok([401, 429].includes(response.statusCode), String(response.statusCode));
        assert.ok(['OTP_INVALID', 'OTP_LOCKED'].includes(response.json().error.code));
      }
      assert.equal((await activeAccounts(PHONE)).length, 1);
    });
  });

  /**
   * Clear the OTP secret, challenge, and attempt counters without touching the
   * database, so a test can run a second send/verify for the same number inside
   * one case. Full `resetState` would drop the rows the assertion needs.
   */
  async function resetOtpState(): Promise<void> {
    const { redis } = await import('../../src/core/cache/client.js');
    const keys = await redis.keys('otp:*');
    if (keys.length > 0) await redis.del(...keys);
  }
});

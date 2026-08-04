import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { FIXED_OTP, bootApp, db, resetState } from './helpers/harness.js';
import { container } from '../../src/core/di.js';
import { redis } from '../../src/core/cache/client.js';
import { RedisKeys } from '../../src/core/cache/keys.js';
import { otpConfig } from '../../src/config/otp/otp.config.js';
import { sessionConfig } from '../../src/config/session/session.config.js';
import type { AuthService } from '../../src/modules/auth/auth.service.js';

const BASE = '/api/v1/auth';

const PHONE = '+919876517001';
const PRIVILEGED = '+919876517002';

/** One login's credentials plus the session row it opened. */
interface Login {
  userId: string;
  accessToken: string;
  sessionId: string;
}

/**
 * The concurrent-session cap (auth doc 07 §3 criterion 7, doc 02 §7's fraud
 * matrix).
 *
 * The eviction has existed since AUTH shipped and nothing asserted it — the one
 * acceptance criterion in either module without coverage
 * (`IMPLEMENTATION_STATUS` §8.1). It is a fraud control: the cap is what stops a
 * stolen credential from quietly accumulating sessions, so "it is implemented"
 * and "it works" need to be different statements.
 *
 * Both halves are covered here, because `capForRoles` picking the wrong number
 * fails open and looks like nothing: an operator account silently getting the
 * standard cap of five instead of two is exactly the account where that matters
 * most.
 */
describe('concurrent-session cap (integration)', () => {
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

  const auth = () => container.resolve<AuthService>('authService');

  /**
   * Log in once more on the same phone.
   *
   * The per-phone OTP counter is cleared first, using the same key builder and
   * the same scope production uses so it cannot drift. Six logins is four more
   * than that limit allows, and the limit under test here is the session cap —
   * `otp:req` has its own coverage in the OTP suite.
   */
  async function login(phoneNumber: string): Promise<Login> {
    await redis.del(RedisKeys.rateLimit(otpConfig.rateLimits.perPhone.scope, phoneNumber));

    const sent = await app.inject({
      method: 'POST',
      url: `${BASE}/otp/send`,
      payload: { phoneNumber },
    });
    assert.equal(sent.statusCode, 200, sent.payload);

    const verified = await app.inject({
      method: 'POST',
      url: `${BASE}/otp/verify`,
      headers: { 'idempotency-key': randomUUID() },
      payload: { phoneNumber, code: FIXED_OTP, challengeId: sent.json().challengeId },
    });
    assert.equal(verified.statusCode, 200, verified.payload);

    const body = verified.json();
    const newest = await db().client.userSession.findFirstOrThrow({
      where: { userId: body.user.id },
      orderBy: { createdAt: 'desc' },
    });
    return { userId: body.user.id, accessToken: body.accessToken, sessionId: newest.id };
  }

  /** Log in `count` times in sequence, oldest session first. */
  async function loginTimes(phoneNumber: string, count: number): Promise<Login[]> {
    const logins: Login[] = [];
    for (let i = 0; i < count; i += 1) logins.push(await login(phoneNumber));
    return logins;
  }

  /** Call an authenticated endpoint with this session's access token. */
  const probe = (accessToken: string) =>
    app.inject({
      method: 'GET',
      url: `${BASE}/me/sessions`,
      headers: { authorization: `Bearer ${accessToken}` },
    });

  /** Every `auth.session.revoked` payload in the outbox. */
  async function revocationEvents(): Promise<
    { userId: string; sessionId: string; reason: string }[]
  > {
    const rows = await db().client.outboxEvent.findMany({
      where: { eventType: 'auth.session.revoked' },
    });
    return rows.map(
      (row) =>
        (row.payload as { data: { userId: string; sessionId: string; reason: string } }).data,
    );
  }

  /** The envelope subject of every `auth.session.revoked` in the outbox. */
  async function revocationSubjects(): Promise<(string | null)[]> {
    const rows = await db().client.outboxEvent.findMany({
      where: { eventType: 'auth.session.revoked' },
    });
    return rows.map(
      (row) => (row.payload as { subject: { userId: string | null } }).subject.userId,
    );
  }

  describe('the standard cap', () => {
    it('lets a user reach the cap without evicting anything', async () => {
      const logins = await loginTimes(PHONE, sessionConfig.maxConcurrentSessions);

      const active = await db().client.userSession.count({
        where: { userId: logins[0]!.userId, revokedAt: null },
      });
      assert.equal(active, sessionConfig.maxConcurrentSessions);
      assert.deepEqual(await revocationEvents(), []);
    });

    it('evicts the oldest session on the login past the cap', async () => {
      const logins = await loginTimes(PHONE, sessionConfig.maxConcurrentSessions + 1);
      const oldest = logins[0]!;

      const row = await db().client.userSession.findUniqueOrThrow({
        where: { id: oldest.sessionId },
      });
      assert.ok(row.revokedAt, 'session #1 is revoked');
      assert.equal(row.revokedReason, 'cap_evicted');
    });

    it('evicts exactly one — the cap is a ceiling, not a reset', async () => {
      const logins = await loginTimes(PHONE, sessionConfig.maxConcurrentSessions + 1);

      const active = await db().client.userSession.count({
        where: { userId: logins[0]!.userId, revokedAt: null },
      });
      assert.equal(active, sessionConfig.maxConcurrentSessions);
    });

    it('signs the evicted session out on its next request', async () => {
      const logins = await loginTimes(PHONE, sessionConfig.maxConcurrentSessions + 1);

      const response = await probe(logins[0]!.accessToken);
      assert.equal(response.statusCode, 401, response.payload);
      assert.equal(response.json().error.code, 'SESSION_REVOKED');
    });

    it('leaves every surviving session working, including the newest', async () => {
      const logins = await loginTimes(PHONE, sessionConfig.maxConcurrentSessions + 1);

      for (const survivor of logins.slice(1)) {
        const response = await probe(survivor.accessToken);
        assert.equal(response.statusCode, 200, response.payload);
      }
    });

    it('emits auth.session.revoked for the evicted session and no other', async () => {
      const logins = await loginTimes(PHONE, sessionConfig.maxConcurrentSessions + 1);

      // Doc 06 §5.2's payload, in full. `userId` is what lets a consumer act on
      // this without joining back to a row erasure may eventually remove.
      assert.deepEqual(await revocationEvents(), [
        { userId: logins[0]!.userId, sessionId: logins[0]!.sessionId, reason: 'cap_evicted' },
      ]);
    });

    it('names the user in the envelope subject as well as the payload', async () => {
      const logins = await loginTimes(PHONE, sessionConfig.maxConcurrentSessions + 1);

      assert.deepEqual(await revocationSubjects(), [logins[0]!.userId]);
    });

    it('keeps evicting one per login once the cap is reached', async () => {
      const logins = await loginTimes(PHONE, sessionConfig.maxConcurrentSessions + 2);

      const active = await db().client.userSession.count({
        where: { userId: logins[0]!.userId, revokedAt: null },
      });
      assert.equal(active, sessionConfig.maxConcurrentSessions);
      assert.deepEqual(
        (await revocationEvents()).map((event) => event.sessionId),
        [logins[0]!.sessionId, logins[1]!.sessionId],
        'oldest first, one per login',
      );
    });

    it('also revokes the evicted session’s refresh tokens', async () => {
      // Otherwise eviction is cosmetic: the holder refreshes and is back in.
      const logins = await loginTimes(PHONE, sessionConfig.maxConcurrentSessions + 1);

      const live = await db().client.refreshToken.count({
        where: { sessionId: logins[0]!.sessionId, revokedAt: null },
      });
      assert.equal(live, 0);
    });
  });

  describe('the privileged cap', () => {
    it('is tighter than the standard one', () => {
      // The test below proves the code reads this; this proves it is worth reading.
      assert.ok(
        sessionConfig.privilegedMaxConcurrentSessions < sessionConfig.maxConcurrentSessions,
      );
    });

    it('applies the privileged number to an operator account', async () => {
      const first = await login(PRIVILEGED);
      await auth().grantRole(first.userId, 'support');

      const logins = [first];
      for (let i = 0; i < sessionConfig.privilegedMaxConcurrentSessions; i += 1) {
        logins.push(await login(PRIVILEGED));
      }

      const active = await db().client.userSession.count({
        where: { userId: first.userId, revokedAt: null },
      });
      assert.equal(active, sessionConfig.privilegedMaxConcurrentSessions);
    });

    it('would still be under the standard cap — so the tighter number is the one that acted', async () => {
      const first = await login(PRIVILEGED);
      await auth().grantRole(first.userId, 'support');

      for (let i = 0; i < sessionConfig.privilegedMaxConcurrentSessions; i += 1) {
        await login(PRIVILEGED);
      }

      const opened = sessionConfig.privilegedMaxConcurrentSessions + 1;
      assert.ok(opened <= sessionConfig.maxConcurrentSessions, 'the standard cap would evict none');
      assert.equal(
        (await revocationEvents()).length,
        opened - sessionConfig.privilegedMaxConcurrentSessions,
      );
    });
  });
});

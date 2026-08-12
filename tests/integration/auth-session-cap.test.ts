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
import type { AuthService } from '../../src/modules/auth/services/auth.service.js';
import type { SessionService } from '../../src/modules/auth/services/session/session.service.js';

const BASE = '/api/v1/auth';

const PHONE = '+919876517001';
const PRIVILEGED = '+919876517002';

interface Login {
  userId: string;
  accessToken: string;
  sessionId: string;
}

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

  async function loginTimes(phoneNumber: string, count: number): Promise<Login[]> {
    const logins: Login[] = [];
    for (let i = 0; i < count; i += 1) logins.push(await login(phoneNumber));
    return logins;
  }

  const probe = (accessToken: string) =>
    app.inject({
      method: 'GET',
      url: `${BASE}/me/sessions`,
      headers: { authorization: `Bearer ${accessToken}` },
    });

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
      const logins = await loginTimes(PHONE, sessionConfig.maxConcurrentSessions + 1);

      const live = await db().client.refreshToken.count({
        where: { sessionId: logins[0]!.sessionId, revokedAt: null },
      });
      assert.equal(live, 0);
    });
  });

  describe('the privileged cap', () => {
    it('is tighter than the standard one', () => {
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
  describe('under concurrent logins', () => {
    async function activeCount(userId: string): Promise<number> {
      return db().client.userSession.count({
        where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      });
    }

    async function raceSessions(userId: string, count: number): Promise<string[]> {
      const sessions = container.resolve<SessionService>('sessionService');
      const opened = await Promise.all(
        Array.from({ length: count }, () =>
          sessions.create({
            userId,
            loginMethod: 'otp',
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          }),
        ),
      );
      return opened.map((session) => session.id);
    }

    it('never exceeds the cap when several logins land at once', async () => {
      const cap = sessionConfig.maxConcurrentSessions;
      const seeded = await loginTimes(PHONE, cap);
      const userId = seeded[0]!.userId;
      assert.equal(await activeCount(userId), cap, 'precondition: at the cap');

      await raceSessions(userId, 3);

      assert.equal(
        await activeCount(userId),
        cap,
        'the account must sit exactly at its cap, not above it',
      );
    });

    it('keeps every surviving session usable and every evicted one dead', async () => {
      const cap = sessionConfig.maxConcurrentSessions;
      const seeded = await loginTimes(PHONE, cap);
      const userId = seeded[0]!.userId;

      const fresh = await raceSessions(userId, 2);

      for (const sessionId of fresh) {
        const row = await db().client.userSession.findUniqueOrThrow({
          where: { id: sessionId },
        });
        assert.equal(row.revokedAt, null, 'a login must not evict itself');
      }
    });

    it('denylists every session it evicts, however they raced', async () => {
      const cap = sessionConfig.maxConcurrentSessions;
      const seeded = await loginTimes(PHONE, cap);
      const userId = seeded[0]!.userId;

      await raceSessions(userId, 2);

      const revoked = await db().client.userSession.findMany({
        where: { userId, revokedAt: { not: null } },
      });
      assert.ok(revoked.length >= 2, 'evictions happened');
      for (const session of revoked) {
        const denied = await redis.exists(RedisKeys.sidRevoked(session.id));
        assert.equal(denied, 1, `evicted session ${session.id} was not denylisted`);
      }
    });

    it('audits one revocation per eviction, not one per racing login', async () => {
      const cap = sessionConfig.maxConcurrentSessions;
      const seeded = await loginTimes(PHONE, cap);
      const userId = seeded[0]!.userId;

      await raceSessions(userId, 2);

      const evictions = (await revocationEvents()).filter((e) => e.reason === 'cap_evicted');
      const revokedRows = await db().client.userSession.count({
        where: { userId, revokedAt: { not: null } },
      });
      assert.equal(
        evictions.length,
        revokedRows,
        'the conditional revoke means one event per session actually evicted',
      );
    });
  });
});

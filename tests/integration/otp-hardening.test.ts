import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { FIXED_OTP, bootApp, db, resetState } from './helpers/harness.js';
import { container } from '../../src/core/di.js';
import { redis } from '../../src/core/cache/client.js';
import { RedisKeys, IDEMPOTENCY_OPERATIONS } from '../../src/core/cache/keys.js';
import { otpConfig } from '../../src/config/otp/otp.config.js';
import { otpQueue } from '../../src/jobs/queues/index.js';
import type { OtpService } from '../../src/modules/auth/services/otp/otp.service.js';

const PHONE = '+919876533001';
const BASE = '/api/v1/auth';

function otpService(): OtpService {
  return container.resolve<OtpService>('otpService');
}

/** Removes only the cooldown, leaving the hourly counter untouched. */
function clearCooldown(purpose: string, phone: string): Promise<number> {
  return redis.del(RedisKeys.otpChallenge(purpose, phone));
}

describe('OTP hardening (integration, real Redis)', () => {
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

  function send(phoneNumber = PHONE, deviceId?: string) {
    return app.inject({
      method: 'POST',
      url: `${BASE}/otp/send`,
      payload: { phoneNumber, ...(deviceId ? { device: { deviceId } } : {}) },
    });
  }

  describe('H-2 — simultaneous sends cannot race', () => {
    it('collapses 8 simultaneous sends into exactly one challenge', async () => {
      const responses = await Promise.all(Array.from({ length: 8 }, () => send()));

      for (const response of responses) {
        assert.equal(response.statusCode, 200, response.payload);
      }

      const challengeIds = new Set(responses.map((r) => r.json().challengeId as string));
      assert.equal(challengeIds.size, 1, 'every caller must be handed the same challenge');

      const rows = await db().client.otpVerification.findMany();
      assert.equal(rows.length, 1, 'exactly one code was minted');
      assert.equal(rows[0]?.id, [...challengeIds][0], 'and it is the one the callers were given');
    });

    it('charges the per-phone budget exactly once for those 8 sends', async () => {
      await Promise.all(Array.from({ length: 8 }, () => send()));

      const counter = await redis.get(
        RedisKeys.rateLimit(otpConfig.rateLimits.perPhone.scope, PHONE),
      );
      assert.equal(counter, '1', 'a race must not be able to spend the hourly budget 8 times');
    });

    it('queues exactly one SMS delivery job for those 8 sends', async () => {
      await Promise.all(Array.from({ length: 8 }, () => send()));

      const counts = await otpQueue().getJobCounts('waiting', 'active', 'completed', 'failed');
      const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
      assert.equal(total, 1, 'the customer must receive one SMS, not eight');
    });

    it('cannot be raced past the hourly limit', async () => {
      const { limit, scope } = otpConfig.rateLimits.perPhone;

      // Spend the budget down to its last slot, then storm it.
      for (let i = 0; i < limit - 1; i += 1) {
        assert.equal((await send()).statusCode, 200);
        await clearCooldown('LOGIN', PHONE);
      }

      const responses = await Promise.all(Array.from({ length: 8 }, () => send()));
      const accepted = responses.filter((r) => r.statusCode === 200);
      assert.ok(accepted.length >= 1, 'the last slot is genuinely usable');

      const counter = Number(await redis.get(RedisKeys.rateLimit(scope, PHONE)));
      assert.equal(counter, limit, `the counter settled at the configured limit (${limit})`);

      // The budget is now spent; a fresh attempt outside the cooldown is refused.
      await clearCooldown('LOGIN', PHONE);
      const refused = await send();
      assert.equal(refused.statusCode, 429, refused.payload);
      assert.equal(refused.json().error.code, 'RATE_LIMITED');
    });

    it('keeps distinct phones independent under the same storm', async () => {
      const other = '+919876533009';
      await Promise.all([...Array(4).fill(PHONE), ...Array(4).fill(other)].map((p) => send(p)));

      const rows = await db().client.otpVerification.findMany();
      assert.equal(rows.length, 2, 'one challenge each, not one shared or eight');
      assert.deepEqual(new Set(rows.map((r) => r.phoneNumber)), new Set([PHONE, other]));
    });

    it('does not consume the cooldown when the request cannot be queued', async () => {
      const service = otpService() as unknown as { otpProducer: { enqueue: unknown } };
      const original = service.otpProducer.enqueue;
      service.otpProducer.enqueue = async () => {
        throw new Error('queue unreachable');
      };

      try {
        const failed = await send();
        assert.equal(failed.statusCode, 500, failed.payload);

        assert.equal(
          await redis.exists(RedisKeys.otpChallenge('LOGIN', PHONE)),
          0,
          'no cooldown may be charged for an SMS that was never handed over',
        );
        assert.equal(
          await redis.exists(RedisKeys.otp('LOGIN', PHONE)),
          0,
          'and the unusable secret is gone',
        );
      } finally {
        service.otpProducer.enqueue = original;
      }

      // The customer can retry at once rather than waiting out a cooldown.
      assert.equal((await send()).statusCode, 200);
    });
  });

  describe('H-3 — idempotency keys are scoped to their operation', () => {
    it('does not replay an OTP verification as a token refresh', async () => {
      const sharedKey = randomUUID();

      const sent = await send();
      const verified = await app.inject({
        method: 'POST',
        url: `${BASE}/otp/verify`,
        headers: { 'idempotency-key': sharedKey },
        payload: { phoneNumber: PHONE, code: FIXED_OTP, challengeId: sent.json().challengeId },
      });
      assert.equal(verified.statusCode, 200, verified.payload);

      const refreshed = await app.inject({
        method: 'POST',
        url: `${BASE}/token/refresh`,
        headers: { 'idempotency-key': sharedKey },
        payload: { refreshToken: verified.json().refreshToken },
      });

      assert.equal(refreshed.statusCode, 200, refreshed.payload);
      assert.equal(
        refreshed.json().user,
        undefined,
        'a refresh must not be handed the verification’s cached body',
      );
      assert.notEqual(
        refreshed.json().refreshToken,
        verified.json().refreshToken,
        'the token was genuinely rotated, not replayed',
      );
    });

    it('stores the two operations under separate Redis keys', async () => {
      const sharedKey = randomUUID();

      const sent = await send();
      const verified = await app.inject({
        method: 'POST',
        url: `${BASE}/otp/verify`,
        headers: { 'idempotency-key': sharedKey },
        payload: { phoneNumber: PHONE, code: FIXED_OTP, challengeId: sent.json().challengeId },
      });
      await app.inject({
        method: 'POST',
        url: `${BASE}/token/refresh`,
        headers: { 'idempotency-key': sharedKey },
        payload: { refreshToken: verified.json().refreshToken },
      });

      const verifyKey = RedisKeys.idempotency(IDEMPOTENCY_OPERATIONS.OTP_VERIFY, sharedKey);
      const refreshKey = RedisKeys.idempotency(IDEMPOTENCY_OPERATIONS.TOKEN_REFRESH, sharedKey);

      assert.notEqual(verifyKey, refreshKey);
      assert.equal(await redis.exists(verifyKey), 1);
      assert.equal(await redis.exists(refreshKey), 1);
    });

    it('still replays the same operation with the same key', async () => {
      const key = randomUUID();
      const sent = await send();
      const payload = {
        phoneNumber: PHONE,
        code: FIXED_OTP,
        challengeId: sent.json().challengeId,
      };

      const first = await app.inject({
        method: 'POST',
        url: `${BASE}/otp/verify`,
        headers: { 'idempotency-key': key },
        payload,
      });
      const replay = await app.inject({
        method: 'POST',
        url: `${BASE}/otp/verify`,
        headers: { 'idempotency-key': key },
        payload,
      });

      assert.equal(first.statusCode, 200, first.payload);
      assert.equal(replay.statusCode, 200, replay.payload);
      assert.equal(replay.json().accessToken, first.json().accessToken, 'same key, same answer');
      assert.equal(await db().client.userSession.count(), 1, 'and only one session was opened');
    });
  });

  describe('H-7 — attempts and locks are purpose-scoped', () => {
    async function exhaust(purpose: 'LOGIN' | 'PHONE_CHANGE'): Promise<void> {
      for (let i = 0; i < otpConfig.maxVerifyAttempts; i += 1) {
        await otpService()
          .verify({ phoneNumber: PHONE, purpose, code: '999999' })
          .catch(() => undefined);
      }
    }

    it('a locked-out LOGIN leaves PHONE_CHANGE untouched', async () => {
      await exhaust('LOGIN');

      assert.equal(await redis.exists(RedisKeys.otpLock('LOGIN', PHONE)), 1, 'LOGIN is locked');
      assert.equal(
        await redis.exists(RedisKeys.otpLock('PHONE_CHANGE', PHONE)),
        0,
        'a login lockout must not deny the account holder a phone change',
      );
      assert.equal(await redis.exists(RedisKeys.otpAttempts('PHONE_CHANGE', PHONE)), 0);
    });

    it('a locked-out PHONE_CHANGE leaves LOGIN untouched', async () => {
      await exhaust('PHONE_CHANGE');

      assert.equal(await redis.exists(RedisKeys.otpLock('PHONE_CHANGE', PHONE)), 1);
      assert.equal(
        await redis.exists(RedisKeys.otpLock('LOGIN', PHONE)),
        0,
        'this was the denial-of-service: a phone-change attack locking its victim out of login',
      );

      // And the API agrees, not just the keyspace.
      const sent = await send();
      const verified = await app.inject({
        method: 'POST',
        url: `${BASE}/otp/verify`,
        headers: { 'idempotency-key': randomUUID() },
        payload: { phoneNumber: PHONE, code: FIXED_OTP, challengeId: sent.json().challengeId },
      });
      assert.equal(verified.statusCode, 200, 'login still works');
    });

    it('counts attempts separately per purpose', async () => {
      await otpService()
        .verify({ phoneNumber: PHONE, purpose: 'LOGIN', code: '999999' })
        .catch(() => undefined);

      assert.equal(await redis.get(RedisKeys.otpAttempts('LOGIN', PHONE)), '1');
      assert.equal(await redis.get(RedisKeys.otpAttempts('PHONE_CHANGE', PHONE)), null);
    });

    it('expires both keys on the lockout window rather than leaking them forever', async () => {
      await exhaust('LOGIN');

      const attemptsTtl = await redis.ttl(RedisKeys.otpAttempts('LOGIN', PHONE));
      const lockTtl = await redis.ttl(RedisKeys.otpLock('LOGIN', PHONE));

      for (const [name, ttl] of [
        ['attempts', attemptsTtl],
        ['lock', lockTtl],
      ] as const) {
        assert.ok(ttl > 0, `${name} must carry a TTL, not persist`);
        assert.ok(
          ttl <= otpConfig.lockoutSeconds,
          `${name} TTL ${ttl} exceeds the configured lockout ${otpConfig.lockoutSeconds}`,
        );
      }
    });
  });
});

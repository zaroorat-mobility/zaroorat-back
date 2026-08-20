import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { FIXED_OTP, bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { createApp } from '../../src/app/app.js';
import { container } from '../../src/core/di.js';
import { redis } from '../../src/core/cache/client.js';
import { RedisKeys } from '../../src/core/cache/keys.js';
import { otpConfig } from '../../src/config/otp/otp.config.js';
import type { EpochService } from '../../src/modules/auth/services/token/epoch.service.js';
import type { DriverAccessRepository } from '../../src/modules/auth/repositories/driver-access.repository.js';
import type { DeviceRepository } from '../../src/modules/auth/repositories/device.repository.js';

const PHONE = '+919876521001';

describe('security properties (integration)', () => {
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

  describe('a database dump yields nothing usable', () => {
    async function dump(): Promise<string> {
      const client = db().client;
      const [users, sessions, refreshTokens, otps, devices, roles, outbox] = await Promise.all([
        client.user.findMany(),
        client.userSession.findMany(),
        client.refreshToken.findMany(),
        client.otpVerification.findMany(),
        client.userDevice.findMany(),
        client.userRoleAssignment.findMany(),
        client.outboxEvent.findMany(),
      ]);
      return JSON.stringify({ users, sessions, refreshTokens, otps, devices, roles, outbox });
    }

    it('holds no raw refresh token, no access token, and no pepper', async () => {
      const user = await loginAs(app, PHONE);
      const contents = await dump();

      const signingSecret = process.env.JWT_ACCESS_SECRET;
      assert.ok(signingSecret, 'the test environment defines a secret worth looking for');

      assert.ok(!contents.includes(user.refreshToken), 'the raw refresh token is not stored');
      assert.ok(!contents.includes(user.accessToken), 'nor is the JWT');
      assert.ok(!contents.includes(otpConfig.pepper), 'nor the hashing pepper');
      assert.ok(!contents.includes(signingSecret), 'nor the signing secret');
    });

    it('stores the refresh token only as a keyed digest', async () => {
      const user = await loginAs(app, PHONE);
      const [row] = await db().client.refreshToken.findMany({ where: { userId: user.userId } });

      assert.ok(row, 'the session has a refresh row');
      assert.notEqual(row.tokenHash, user.refreshToken);

      assert.match(row.tokenHash, /^[0-9a-f]{64}$/);
    });

    it('never records the OTP code on the attempt trail', async () => {
      const sent = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/send',
        payload: { phoneNumber: PHONE },
      });
      const attempt = await db().client.otpVerification.findUniqueOrThrow({
        where: { id: sent.json().challengeId },
      });

      for (const [field, value] of Object.entries(attempt)) {
        assert.notEqual(String(value), FIXED_OTP, `${field} holds the code`);
      }

      const stored = await redis.get(RedisKeys.otp('LOGIN', PHONE));
      assert.ok(stored && stored !== FIXED_OTP, 'even Redis holds only the digest');
    });

    it('keeps the code out of the events the change emits', async () => {
      await loginAs(app, PHONE);
      const rows = await db().client.outboxEvent.findMany();
      const payloads = JSON.stringify(rows.map((row) => row.payload));

      for (const [key, value] of Object.entries({ code: FIXED_OTP })) {
        assert.ok(!payloads.includes(`"${key}":"${value}"`), `${key} reached an event`);
      }
      assert.ok(rows.length > 0, 'and there were events to check');
    });
  });

  describe('each rate-limit axis trips on its own', () => {
    function send(phoneNumber: string, deviceId?: string) {
      return app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/send',
        payload: { phoneNumber, ...(deviceId ? { device: { deviceId } } : {}) },
      });
    }

    function clearCooldown(phoneNumber: string) {
      return redis.del(RedisKeys.otpChallenge('LOGIN', phoneNumber));
    }

    it('accepts the client-reported device id doc 04 §2.1 documents', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/send',
        payload: {
          phoneNumber: PHONE,
          device: { deviceId: 'a1b2c3', platform: 'ANDROID', appVersion: '1.4.0' },
        },
      });
      assert.equal(response.statusCode, 200, response.payload);

      const attempt = await db().client.otpVerification.findUniqueOrThrow({
        where: { id: response.json().challengeId },
      });
      assert.equal(attempt.deviceId, null);
    });

    it('trips the per-phone axis on its own limit', async () => {
      const limit = otpConfig.rateLimits.perPhone.limit;
      for (let i = 0; i < limit; i += 1) {
        assert.equal((await send(PHONE)).statusCode, 200, `send ${i + 1}`);
        await clearCooldown(PHONE);
      }

      const blocked = await send(PHONE);
      assert.equal(blocked.statusCode, 429);
      assert.equal(blocked.json().error.code, 'RATE_LIMITED');
      assert.ok(blocked.headers['retry-after'], 'with a wait hint');
    });

    it('trips the per-device axis across different phones', async () => {
      const limit = otpConfig.rateLimits.perDevice.limit;

      for (let i = 0; i < limit; i += 1) {
        assert.equal((await send(`+91987652${2000 + i}`, 'device-x')).statusCode, 200, `send ${i}`);
      }

      const blocked = await send('+919876522999', 'device-x');
      assert.equal(blocked.statusCode, 429);
      assert.equal(blocked.json().error.code, 'RATE_LIMITED');
    });

    it('trips the per-IP axis across different phones and devices', async () => {
      const limit = otpConfig.rateLimits.perIp.limit;

      for (let i = 0; i < limit; i += 1) {
        assert.equal(
          (await send(`+91987653${1000 + i}`, `device-${i}`)).statusCode,
          200,
          `send ${i}`,
        );
      }

      const blocked = await send('+919876539999', 'device-last');
      assert.equal(blocked.statusCode, 429);
    });

    it('applies the strictest axis, not the first one configured', async () => {
      for (let i = 0; i < otpConfig.rateLimits.perPhone.limit; i += 1) {
        await send(PHONE, 'device-y');
        await clearCooldown(PHONE);
      }
      assert.equal((await send(PHONE, 'device-y')).statusCode, 429);

      assert.equal((await send('+919876524001', 'device-y')).statusCode, 200);
    });

    it('does not leak whether the phone is registered', async () => {
      await loginAs(app, PHONE);
      await clearCooldown(PHONE);

      const known = await send(PHONE);
      const unknown = await send('+919876525999');

      assert.equal(known.statusCode, unknown.statusCode);
      assert.deepEqual(Object.keys(known.json()).sort(), Object.keys(unknown.json()).sort());
      assert.equal(known.json().expiresInSec, unknown.json().expiresInSec);
    });
  });

  describe('an unreachable dependency refuses rather than admits', () => {
    async function broken<T extends object, K extends keyof T>(
      target: T,
      method: K,
      body: () => Promise<void>,
    ): Promise<void> {
      const original = target[method];
      target[method] = (() => {
        throw new Error('dependency unavailable');
      }) as T[K];
      try {
        await body();
      } finally {
        target[method] = original;
      }
    }

    it('answers 503 when the epoch store is down, never 200', async () => {
      const user = await loginAs(app, PHONE);
      const epoch = container.resolve<EpochService>('epochService');

      await broken(epoch, 'current', async () => {
        const response = await app.inject({
          method: 'GET',
          url: '/api/v1/users/me',
          headers: { authorization: `Bearer ${user.accessToken}` },
        });

        assert.equal(response.statusCode, 503);
        assert.equal(response.json().error.code, 'SERVICE_UNAVAILABLE');
      });
    });

    it('recovers as soon as the dependency does', async () => {
      const user = await loginAs(app, PHONE);
      const epoch = container.resolve<EpochService>('epochService');
      await broken(epoch, 'current', async () => undefined);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/users/me',
        headers: { authorization: `Bearer ${user.accessToken}` },
      });
      assert.equal(response.statusCode, 200, 'failing closed is not failing permanently');
    });

    it('answers 503 when the driver-operability read fails', async () => {
      const guarded = await createApp();
      guarded.get(
        '/test/ride-accept',
        { preHandler: [guarded.authorize({ requireOperableDriver: true })] },
        async () => ({ accepted: true }),
      );
      await guarded.ready();

      try {
        const user = await loginAs(guarded, PHONE);
        const driverAccess = container.resolve<DriverAccessRepository>('driverAccessRepository');

        await broken(driverAccess, 'isOperableDriver', async () => {
          const response = await guarded.inject({
            method: 'GET',
            url: '/test/ride-accept',
            headers: { authorization: `Bearer ${user.accessToken}` },
          });
          assert.equal(response.statusCode, 503);
          assert.equal(response.json().error.code, 'SERVICE_UNAVAILABLE');
        });
      } finally {
        await guarded.close();
      }
    });

    it('answers 503 when the device check fails, on a sensitive action', async () => {
      const user = await loginAs(app, PHONE);
      const devices = container.resolve<DeviceRepository>('deviceRepository');

      await broken(devices, 'findBySession', async () => {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/users/me/phone/change',
          headers: user.authHeader,
          payload: { newPhoneNumber: '+919876526001' },
        });

        assert.equal(response.statusCode, 503, response.payload);
        assert.equal(response.json().error.code, 'SERVICE_UNAVAILABLE');
      });

      const row = await db().client.user.findUniqueOrThrow({ where: { id: user.userId } });
      assert.equal(row.phoneNumber, PHONE, 'and nothing changed');
    });

    it('does not fall through to success on the rate-limit path either', async () => {
      const limiter = container.resolve<{ hit: unknown }>('rateLimitStore');

      await broken(limiter as { hit: () => never }, 'hit', async () => {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/otp/send',
          payload: { phoneNumber: PHONE },
        });

        assert.notEqual(response.statusCode, 200, response.payload);
      });

      assert.equal(
        await db().client.otpVerification.count({ where: { phoneNumber: PHONE } }),
        0,
        'no code was sent while the limiter was blind',
      );
    });
  });
});

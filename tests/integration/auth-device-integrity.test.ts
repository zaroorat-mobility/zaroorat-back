import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { FIXED_OTP, db, resetState } from './helpers/harness.js';
import { createApp } from '../../src/app/app.js';

const BASE = '/api/v1/auth';
const PHONE = '+919876518001';
const TARGET = '+919876518002';

describe('tampered-device refusal (integration)', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await createApp();
    app.post(
      '/test/wallet-debit',
      { preHandler: [app.authorize({ requireUntamperedDevice: true })] },
      async () => ({ debited: true }),
    );
    await app.ready();
  });
  after(async () => {
    await app.close();
  });
  afterEach(async () => {
    await resetState();
  });

  async function login(
    phoneNumber: string,
    device: Record<string, unknown> = { deviceId: 'phone-a' },
  ) {
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
      payload: { phoneNumber, code: FIXED_OTP, challengeId: sent.json().challengeId, device },
    });
    assert.equal(verified.statusCode, 200, verified.payload);
    return {
      userId: verified.json().user.id,
      accessToken: verified.json().accessToken,
      authHeader: { authorization: `Bearer ${verified.json().accessToken}` },
    };
  }

  function sensitiveAction(accessToken: string) {
    return app.inject({
      method: 'POST',
      url: '/test/wallet-debit',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {},
    });
  }

  it('lets a tampered device authenticate and use the app normally', async () => {
    const rooted = await login(PHONE, { deviceId: 'phone-a', isRooted: true });

    const ordinary = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: rooted.authHeader,
    });
    assert.equal(ordinary.statusCode, 200, ordinary.payload);

    const stored = await db().client.userDevice.findFirstOrThrow({
      where: { userId: rooted.userId },
    });
    assert.equal(stored.isRooted, true, 'the signal is captured, not discarded');
  });

  it('refuses the sensitive action from a rooted device', async () => {
    const rooted = await login(PHONE, { deviceId: 'phone-a', isRooted: true });
    const response = await sensitiveAction(rooted.accessToken);

    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error.code, 'FORBIDDEN');
  });

  it('refuses the sensitive action from a jailbroken device', async () => {
    const jailbroken = await login(PHONE, { deviceId: 'phone-a', isJailbroken: true });
    assert.equal((await sensitiveAction(jailbroken.accessToken)).statusCode, 403);
  });

  it('allows the sensitive action from a clean device', async () => {
    const clean = await login(PHONE, { deviceId: 'phone-a', platform: 'ANDROID' });
    const response = await sensitiveAction(clean.accessToken);

    assert.equal(response.statusCode, 200, response.payload);
    assert.deepEqual(response.json(), { debited: true });
  });

  it('denies a session it cannot assess, rather than waving it through', async () => {
    const clean = await login(PHONE, { deviceId: 'phone-a' });

    await db().client.userSession.updateMany({
      where: { userId: clean.userId },
      data: { deviceId: null },
    });

    assert.equal((await sensitiveAction(clean.accessToken)).statusCode, 403);
  });

  it('follows the device, so re-logging in on a clean handset restores access', async () => {
    const rooted = await login(PHONE, { deviceId: 'phone-a', isRooted: true });
    assert.equal((await sensitiveAction(rooted.accessToken)).statusCode, 403);

    const clean = await login(PHONE, { deviceId: 'clean-b' });
    assert.equal((await sensitiveAction(clean.accessToken)).statusCode, 200);
    assert.equal(
      (await sensitiveAction(rooted.accessToken)).statusCode,
      403,
      'and the rooted one is still refused',
    );
  });

  it('re-evaluates on the next request when the flag is raised mid-session', async () => {
    const clean = await login(PHONE, { deviceId: 'phone-a' });
    assert.equal((await sensitiveAction(clean.accessToken)).statusCode, 200);

    await db().client.userDevice.updateMany({
      where: { userId: clean.userId },
      data: { isRooted: true },
    });

    assert.equal((await sensitiveAction(clean.accessToken)).statusCode, 403);
  });

  describe('the phone-number change (doc 02 §5.2’s own example)', () => {
    it('refuses both steps from a rooted device', async () => {
      const rooted = await login(PHONE, { deviceId: 'phone-a', isRooted: true });

      const requested = await app.inject({
        method: 'POST',
        url: '/api/v1/users/me/phone/change',
        headers: rooted.authHeader,
        payload: { newPhoneNumber: TARGET },
      });
      assert.equal(requested.statusCode, 403, requested.payload);
      assert.equal(requested.json().error.code, 'FORBIDDEN');

      const verified = await app.inject({
        method: 'POST',
        url: '/api/v1/users/me/phone/verify',
        headers: { ...rooted.authHeader, 'idempotency-key': randomUUID() },
        payload: { challengeId: randomUUID(), code: FIXED_OTP },
      });
      assert.equal(verified.statusCode, 403);

      const row = await db().client.user.findUniqueOrThrow({ where: { id: rooted.userId } });
      assert.equal(row.phoneNumber, PHONE, 'the number is untouched');
    });

    it('still works from a clean device', async () => {
      const clean = await login(PHONE, { deviceId: 'phone-a' });
      const requested = await app.inject({
        method: 'POST',
        url: '/api/v1/users/me/phone/change',
        headers: clean.authHeader,
        payload: { newPhoneNumber: TARGET },
      });
      assert.equal(requested.statusCode, 202, requested.payload);
    });

    it('leaves the rest of the module open to a tampered device', async () => {
      const rooted = await login(PHONE, { deviceId: 'phone-a', isRooted: true });

      const profile = await app.inject({
        method: 'PATCH',
        url: '/api/v1/users/me/profile',
        headers: rooted.authHeader,
        payload: { firstName: 'Priya' },
      });
      assert.equal(profile.statusCode, 200, profile.payload);
      assert.equal(
        (
          await app.inject({
            method: 'GET',
            url: '/api/v1/users/me/saved-places',
            headers: rooted.authHeader,
          })
        ).statusCode,
        200,
      );
    });
  });
});

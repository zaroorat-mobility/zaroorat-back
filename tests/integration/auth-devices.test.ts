import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { FIXED_OTP, bootApp, db, resetState } from './helpers/harness.js';

const OWNER = '+919876516001';
const STRANGER = '+919876516002';

const DEVICES = '/api/v1/auth/me/devices';

describe('device management (integration)', () => {
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

  async function loginWithDevice(phoneNumber: string, deviceId: string, platform = 'ANDROID') {
    const sent = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/send',
      payload: { phoneNumber },
    });
    assert.equal(sent.statusCode, 200, sent.payload);
    const verified = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/verify',
      headers: { 'idempotency-key': randomUUID() },
      payload: {
        phoneNumber,
        code: FIXED_OTP,
        challengeId: sent.json().challengeId,
        device: { deviceId, platform },
      },
    });
    assert.equal(verified.statusCode, 200, verified.payload);
    const body = verified.json();
    return {
      userId: body.user.id,
      accessToken: body.accessToken,
      authHeader: { authorization: `Bearer ${body.accessToken}` },
    };
  }

  function list(accessToken: string) {
    return app.inject({
      method: 'GET',
      url: DEVICES,
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  function revoke(accessToken: string, id: string) {
    return app.inject({
      method: 'DELETE',
      url: `${DEVICES}/${id}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  it('lists the caller’s devices and marks the one that is calling', async () => {
    const phone = await loginWithDevice(OWNER, 'phone-a');
    const tablet = await loginWithDevice(OWNER, 'tablet-b', 'IOS');

    const response = await list(tablet.accessToken);
    assert.equal(response.statusCode, 200, response.payload);
    const devices = response.json().devices as { deviceId: string; current: boolean }[];

    assert.equal(devices.length, 2, 'both bindings are listed');
    assert.deepEqual(
      devices.filter((d) => d.current).map((d) => d.deviceId),
      ['tablet-b'],
      'exactly the calling device is marked — the client can warn before self-revoking',
    );
    assert.ok(devices.some((d) => d.deviceId === 'phone-a'));
    void phone;
  });

  it('never returns the fingerprint it matches against (R-DEVICE-5)', async () => {
    const sent = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/send',
      payload: { phoneNumber: OWNER },
    });
    const verified = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/verify',
      headers: { 'idempotency-key': randomUUID() },
      payload: {
        phoneNumber: OWNER,
        code: FIXED_OTP,
        challengeId: sent.json().challengeId,
        device: { deviceId: 'phone-a', fingerprint: 'fp-secret-value', isRooted: true },
      },
    });
    assert.equal(verified.statusCode, 200, verified.payload);

    const response = await list(verified.json().accessToken);

    assert.ok(!response.payload.includes('fp-secret-value'), 'no fingerprint on the wire');
    assert.ok(!response.payload.includes('fingerprint'), 'not even the key');

    const [device] = response.json().devices as { isRooted: boolean; trustState: string }[];
    assert.equal(device?.isRooted, true, 'but the user does see what was captured about them');
    assert.equal(device?.trustState, 'REGISTERED');
  });

  it('revokes a device and ends every session bound to it (AUTH-INV-6)', async () => {
    const phone = await loginWithDevice(OWNER, 'phone-a');
    const tablet = await loginWithDevice(OWNER, 'tablet-b');

    const devices = (await list(tablet.accessToken)).json().devices as {
      id: string;
      deviceId: string;
    }[];
    const lost = devices.find((d) => d.deviceId === 'phone-a')!;

    assert.equal((await revoke(tablet.accessToken, lost.id)).statusCode, 204);

    const signedOut = await list(phone.accessToken);
    assert.equal(signedOut.statusCode, 401);
    assert.equal(signedOut.json().error.code, 'SESSION_REVOKED');
    assert.equal((await list(tablet.accessToken)).statusCode, 200, 'the caller keeps working');

    const row = await db().client.userDevice.findUniqueOrThrow({ where: { id: lost.id } });
    assert.equal(row.trustState, 'REVOKED');
    assert.equal(
      await db().client.userSession.count({ where: { deviceId: lost.id, revokedAt: null } }),
      0,
    );
  });

  it('keeps the revoked device visible, with its state (never hides a security event)', async () => {
    const phone = await loginWithDevice(OWNER, 'phone-a');
    const tablet = await loginWithDevice(OWNER, 'tablet-b');
    const devices = (await list(tablet.accessToken)).json().devices as {
      id: string;
      deviceId: string;
    }[];
    await revoke(tablet.accessToken, devices.find((d) => d.deviceId === 'phone-a')!.id);

    const after = (await list(tablet.accessToken)).json().devices as {
      deviceId: string;
      trustState: string;
    }[];
    assert.equal(after.length, 2, 'the revoked device is still listed');
    assert.equal(after.find((d) => d.deviceId === 'phone-a')?.trustState, 'REVOKED');
    void phone;
  });

  it('lets a revoked device back in only by re-verifying (R-DEVICE-3)', async () => {
    const phone = await loginWithDevice(OWNER, 'phone-a');
    const tablet = await loginWithDevice(OWNER, 'tablet-b');
    const devices = (await list(tablet.accessToken)).json().devices as {
      id: string;
      deviceId: string;
    }[];
    const lost = devices.find((d) => d.deviceId === 'phone-a')!;
    await revoke(tablet.accessToken, lost.id);
    assert.equal((await list(phone.accessToken)).statusCode, 401);

    const returned = await loginWithDevice(OWNER, 'phone-a');
    assert.equal((await list(returned.accessToken)).statusCode, 200);

    const row = await db().client.userDevice.findUniqueOrThrow({ where: { id: lost.id } });
    assert.equal(row.trustState, 'REGISTERED', 'the same binding, cleared by re-verification');
  });

  it('audits the revocation as the user’s own, not an ops action', async () => {
    const tablet = await loginWithDevice(OWNER, 'tablet-b');
    await loginWithDevice(OWNER, 'phone-a');
    const devices = (await list(tablet.accessToken)).json().devices as {
      id: string;
      deviceId: string;
    }[];
    const target = devices.find((d) => d.deviceId === 'phone-a')!;
    await revoke(tablet.accessToken, target.id);

    const rows = await db().client.outboxEvent.findMany({
      where: { eventType: 'auth.device.revoked' },
    });
    assert.equal(rows.length, 1);
    const payload = rows[0]!.payload as unknown as { data: Record<string, unknown> };
    assert.deepEqual(payload.data, {
      userId: tablet.userId,
      deviceId: target.id,
      to: 'REVOKED',
      actor: 'self',
    });
  });

  it('will not let one account see or revoke another’s devices', async () => {
    const owner = await loginWithDevice(OWNER, 'phone-a');
    const stranger = await loginWithDevice(STRANGER, 'phone-c');
    const [ownerDevice] = (await list(owner.accessToken)).json().devices as { id: string }[];

    assert.deepEqual(
      ((await list(stranger.accessToken)).json().devices as { deviceId: string }[]).map(
        (d) => d.deviceId,
      ),
      ['phone-c'],
      'the list is scoped to the caller',
    );

    const stolen = await revoke(stranger.accessToken, ownerDevice!.id);

    assert.equal(stolen.statusCode, 404, 'not owned reads exactly like not found');
    const row = await db().client.userDevice.findUniqueOrThrow({ where: { id: ownerDevice!.id } });
    assert.equal(row.trustState, 'REGISTERED', 'and the owner’s device is untouched');
  });

  it('answers an unknown id the same way as one belonging to someone else', async () => {
    const owner = await loginWithDevice(OWNER, 'phone-a');
    const stranger = await loginWithDevice(STRANGER, 'phone-c');
    const [ownerDevice] = (await list(owner.accessToken)).json().devices as { id: string }[];

    const notOwned = await revoke(stranger.accessToken, ownerDevice!.id);
    const unknown = await revoke(stranger.accessToken, randomUUID());

    const strip = (raw: string) => {
      const body = JSON.parse(raw) as { error: Record<string, unknown> };
      delete body.error.requestId;
      return body;
    };
    assert.equal(notOwned.statusCode, unknown.statusCode);
    assert.deepEqual(strip(notOwned.payload), strip(unknown.payload));
  });

  it('is closed to unauthenticated callers', async () => {
    for (const [method, url] of [
      ['GET', DEVICES],
      ['DELETE', `${DEVICES}/${randomUUID()}`],
    ] as const) {
      const response = await app.inject({ method, url });
      assert.equal(response.statusCode, 401, url);
      assert.equal(response.json().error.code, 'TOKEN_INVALID', url);
    }
  });
});

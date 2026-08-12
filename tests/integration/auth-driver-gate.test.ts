import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { db, resetState, FIXED_OTP } from './helpers/harness.js';
import { createApp } from '../../src/app/app.js';

const BASE = '/api/v1/auth';

describe('driver operability gate (AUTH-INV-7, integration)', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await createApp();
    app.get(
      '/test/ride-accept',
      { preHandler: [app.authorize({ roles: ['driver'], requireOperableDriver: true })] },
      async () => ({ accepted: true }),
    );
    await app.ready();
  });
  after(async () => {
    await app.close();
  });
  afterEach(async () => {
    await resetState();
  });

  async function login(phone: string): Promise<{ accessToken: string; userId: string }> {
    const sent = await app.inject({
      method: 'POST',
      url: `${BASE}/otp/send`,
      payload: { phoneNumber: phone },
    });
    const challengeId = sent.json().challengeId as string;
    const verified = await app.inject({
      method: 'POST',
      url: `${BASE}/otp/verify`,
      headers: { 'idempotency-key': randomUUID() },
      payload: { phoneNumber: phone, code: FIXED_OTP, challengeId },
    });
    assert.equal(verified.statusCode, 200, verified.payload);
    return { accessToken: verified.json().accessToken, userId: verified.json().user.id };
  }

  async function driverLogin(phone: string): Promise<{ accessToken: string; userId: string }> {
    const first = await login(phone);
    const role = await db().client.role.findUniqueOrThrow({ where: { slug: 'driver' } });
    await db().client.userRoleAssignment.create({
      data: { userId: first.userId, roleId: role.id },
    });

    return login(phone);
  }

  const rideAccept = (accessToken: string) =>
    app.inject({
      method: 'GET',
      url: '/test/ride-accept',
      headers: { authorization: `Bearer ${accessToken}` },
    });

  async function makeDriver(
    userId: string,
    fields: { verificationStatus?: 'PENDING' | 'VERIFIED'; isSuspended?: boolean } = {},
  ): Promise<void> {
    await db().client.driver.create({
      data: {
        userId,
        driverCode: `D-${userId.slice(0, 8)}`,
        verificationStatus: fields.verificationStatus ?? 'VERIFIED',
        isSuspended: fields.isSuspended ?? false,
      },
    });
  }

  it('denies a driver-role user with no VERIFIED driver record (FORBIDDEN)', async () => {
    const { accessToken } = await driverLogin('+919876500020');
    const res = await rideAccept(accessToken);
    assert.equal(res.statusCode, 403, res.payload);
    assert.equal(res.json().error.code, 'FORBIDDEN');
  });

  it('allows once the driver is VERIFIED and not suspended', async () => {
    const { accessToken, userId } = await driverLogin('+919876500021');
    await makeDriver(userId, { verificationStatus: 'VERIFIED', isSuspended: false });

    const res = await rideAccept(accessToken);
    assert.equal(res.statusCode, 200, res.payload);
    assert.deepEqual(res.json(), { accepted: true });
  });

  it('denies when verification is not VERIFIED, even with the driver role (regression guard)', async () => {
    const { accessToken, userId } = await driverLogin('+919876500022');
    await makeDriver(userId, { verificationStatus: 'PENDING' });

    const res = await rideAccept(accessToken);
    assert.equal(res.statusCode, 403, res.payload);
    assert.equal(res.json().error.code, 'FORBIDDEN');
  });

  it('denies a VERIFIED-but-suspended driver', async () => {
    const { accessToken, userId } = await driverLogin('+919876500023');
    await makeDriver(userId, { verificationStatus: 'VERIFIED', isSuspended: true });

    const res = await rideAccept(accessToken);
    assert.equal(res.statusCode, 403, res.payload);
    assert.equal(res.json().error.code, 'FORBIDDEN');
  });

  it('denies a non-driver (customer only) regardless of driver records', async () => {
    const { accessToken } = await login('+919876500024');
    const res = await rideAccept(accessToken);
    assert.equal(res.statusCode, 403, res.payload);
    assert.equal(res.json().error.code, 'FORBIDDEN');
  });
});

import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { grantRole } from './helpers/fixtures.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';

const ADMIN_PHONE = '+919876544011';
const ADMIN_EMAIL = 'settings-admin@zaroorat.test';
const ADMIN_PASSWORD = 'Admin@12345';

describe('admin settings and verification totals (integration Step 4)', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await bootApp();
  });
  after(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetState();
  });
  afterEach(async () => {
    await resetState();
  });

  async function loginStaff(role = 'system_admin') {
    const seed = await loginAs(app, ADMIN_PHONE);
    await grantRole(seed.userId, role);
    await db().client.user.update({
      where: { id: seed.userId },
      data: {
        email: ADMIN_EMAIL,
        passwordHash: hashPassword(ADMIN_PASSWORD),
        isEmailVerified: true,
      },
    });
    const loggedIn = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/admin/login',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    if (loggedIn.statusCode !== 200) {
      throw new Error(`staff login failed: ${loggedIn.payload}`);
    }
    const body = loggedIn.json();
    return {
      userId: body.user.id as string,
      authHeader: { authorization: `Bearer ${body.accessToken}` },
    };
  }

  it('ride settings round-trip with arrival radii, accuracy, confirmation count and dispatch limits', async () => {
    const admin = await loginStaff('system_admin');

    // 1. Read initial settings
    const initial = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/settings/ride',
      headers: admin.authHeader,
    });
    assert.equal(initial.statusCode, 200, initial.payload);
    const initData = initial.json().data;
    assert.ok(initData.pickupGeofenceMeters !== undefined);
    assert.ok(initData.dropGeofenceMeters !== undefined);
    assert.ok(initData.arrivalMaxAccuracyMeters !== undefined);
    assert.ok(initData.arrivalRequiredFixes !== undefined);
    assert.ok(initData.dispatchMaxRounds !== undefined);
    assert.ok(initData.dispatchMaxAttemptedDrivers !== undefined);

    // 2. Update ride settings
    const updated = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings/ride',
      headers: admin.authHeader,
      payload: {
        pickupGeofenceMeters: 85,
        dropGeofenceMeters: 95,
        arrivalMaxAccuracyMeters: 35,
        arrivalRequiredFixes: 4,
        dispatchMaxRounds: 7,
        dispatchMaxAttemptedDrivers: 25,
      },
    });
    assert.equal(updated.statusCode, 200, updated.payload);

    // 3. Verify round-trip values persisted
    const readBack = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/settings/ride',
      headers: admin.authHeader,
    });
    assert.equal(readBack.statusCode, 200, readBack.payload);
    const finalData = readBack.json().data;
    assert.equal(finalData.pickupGeofenceMeters.value, 85);
    assert.equal(finalData.pickupGeofenceMeters.source, 'database');
    assert.equal(finalData.dropGeofenceMeters.value, 95);
    assert.equal(finalData.arrivalMaxAccuracyMeters.value, 35);
    assert.equal(finalData.arrivalRequiredFixes.value, 4);
    assert.equal(finalData.dispatchMaxRounds.value, 7);
    assert.equal(finalData.dispatchMaxAttemptedDrivers.value, 25);
  });

  it('verification stats endpoint returns authoritative database aggregates and rejection metadata', async () => {
    const admin = await loginStaff('system_admin');

    const prisma = db().client;

    // Driver 1: VERIFIED
    const u1 = await loginAs(app, '+919876544021');
    await prisma.driver.create({
      data: {
        userId: u1.userId,
        driverCode: 'DRV-101',
        verificationStatus: 'VERIFIED',
      },
    });

    // Driver 2: created as PENDING, then rejected via admin API
    const u2 = await loginAs(app, '+919876544022');
    const d2 = await prisma.driver.create({
      data: {
        userId: u2.userId,
        driverCode: 'DRV-102',
        verificationStatus: 'PENDING',
      },
    });
    const rejCall = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/applications/${d2.id}/reject`,
      headers: admin.authHeader,
      payload: { notes: 'Blurry Driving License Photo' },
    });
    assert.equal(rejCall.statusCode, 200, rejCall.payload);

    // Driver 3: DOCUMENT_REVIEW (under_review)
    const u3 = await loginAs(app, '+919876544023');
    await prisma.driver.create({
      data: {
        userId: u3.userId,
        driverCode: 'DRV-103',
        verificationStatus: 'DOCUMENT_REVIEW',
      },
    });

    // Driver 4: PENDING (pending_review)
    const u4 = await loginAs(app, '+919876544024');
    await prisma.driver.create({
      data: {
        userId: u4.userId,
        driverCode: 'DRV-104',
        verificationStatus: 'PENDING',
      },
    });

    // Call verification stats endpoint
    const statsRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/applications/stats',
      headers: admin.authHeader,
    });
    assert.equal(statsRes.statusCode, 200, statsRes.payload);
    const stats = statsRes.json().data;

    assert.equal(stats.approved, 1);
    assert.equal(stats.rejected, 1);
    assert.equal(stats.underReview, 1);
    assert.equal(stats.pendingReview, 1);
    assert.equal(stats.total, 4);

    // Verify rejection metadata
    assert.ok(stats.recentRejections.length >= 1);
    const rej = (
      stats.recentRejections as Array<{
        driverId: string;
        driverCode: string;
        reason: string;
        reviewerId: string;
        timestamp: string;
      }>
    ).find((r) => r.driverId === d2.id);
    assert.ok(rej);
    assert.equal(rej.driverCode, 'DRV-102');
    assert.equal(rej.reason, 'Blurry Driving License Photo');
    assert.equal(rej.reviewerId, admin.userId);
    assert.ok(rej.timestamp);
  });
});

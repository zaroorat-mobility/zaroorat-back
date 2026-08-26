import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { grantRole, makeDriver } from './helpers/fixtures.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';
import { driverConfig } from '../../src/config/driver/driver.config.js';

const ADMIN_PHONE = '+919876544001';
const DRIVER_PHONE = '+919876544002';
const SUPPORT_PHONE = '+919876544003';
const ADMIN_EMAIL = 'app-admin@zaroorat.test';
const ADMIN_PASSWORD = 'Admin@12345';

describe('admin applications (integration)', () => {
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

  async function loginStaff(phone: string, role: string, email = ADMIN_EMAIL) {
    const seed = await loginAs(app, phone);
    await grantRole(seed.userId, role);
    await db().client.user.update({
      where: { id: seed.userId },
      data: {
        email,
        passwordHash: hashPassword(ADMIN_PASSWORD),
        isEmailVerified: true,
      },
    });
    const loggedIn = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/admin/login',
      payload: { email, password: ADMIN_PASSWORD },
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

  async function seedPendingApplication(withVerifiedDocs = false) {
    const user = await loginAs(app, DRIVER_PHONE);
    await grantRole(user.userId, 'driver');
    await db().client.userProfile.upsert({
      where: { userId: user.userId },
      create: { userId: user.userId, firstName: 'Pending', lastName: 'Applicant' },
      update: { firstName: 'Pending', lastName: 'Applicant' },
    });
    const driverId = await makeDriver(user.userId, { verified: false });
    await db().client.driverProfile.create({
      data: {
        driverId,
        fullLegalName: 'Pending Applicant',
        city: 'Srinagar',
        state: 'Jammu & Kashmir',
      },
    });

    if (withVerifiedDocs) {
      for (const documentType of driverConfig.requiredDocumentTypes) {
        await db().client.driverDocument.create({
          data: {
            driverId,
            documentType,
            verificationStatus: 'VERIFIED',
            fileUrl: `https://example.invalid/${documentType.toLowerCase()}.jpg`,
          },
        });
      }
    }

    return { ...user, driverId };
  }

  it('lists pending applications and returns detail for drivers:read', async () => {
    const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
    const pending = await seedPendingApplication();
    const verifiedId = await makeDriver(
      (
        await (async () => {
          const u = await loginAs(app, '+919876544099');
          await grantRole(u.userId, 'driver');
          return u;
        })()
      ).userId,
      { verified: true },
    );

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/applications',
      headers: admin.authHeader,
    });
    assert.equal(listed.statusCode, 200, listed.payload);
    const rows = listed.json().data as Array<{ id: string; applicationStatus: string }>;
    assert.ok(rows.some((row) => row.id === pending.driverId));
    assert.ok(!rows.some((row) => row.id === verifiedId));
    const match = rows.find((row) => row.id === pending.driverId)!;
    assert.equal(match.applicationStatus, 'pending_review');

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/applications/${pending.driverId}`,
      headers: admin.authHeader,
    });
    assert.equal(detail.statusCode, 200, detail.payload);
    assert.equal(detail.json().data.driverName, 'Pending Applicant');
    assert.equal(detail.json().data.applicationStatus, 'pending_review');
  });

  it('approves an eligible application with drivers:verify', async () => {
    const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
    const pending = await seedPendingApplication(true);

    const approved = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/applications/${pending.driverId}/approve`,
      headers: admin.authHeader,
      payload: { notes: 'Docs clear' },
    });
    assert.equal(approved.statusCode, 200, approved.payload);
    assert.equal(approved.json().data.applicationStatus, 'approved');

    const driver = await db().client.driver.findUniqueOrThrow({
      where: { id: pending.driverId },
    });
    assert.equal(driver.verificationStatus, 'VERIFIED');

    const gone = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/applications/${pending.driverId}`,
      headers: admin.authHeader,
    });
    assert.equal(gone.statusCode, 409, gone.payload);
  });

  it('rejects an application with drivers:verify', async () => {
    const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
    const pending = await seedPendingApplication();

    const rejected = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/applications/${pending.driverId}/reject`,
      headers: admin.authHeader,
      payload: { notes: 'Incomplete KYC' },
    });
    assert.equal(rejected.statusCode, 200, rejected.payload);
    assert.equal(rejected.json().data.applicationStatus, 'rejected');

    const driver = await db().client.driver.findUniqueOrThrow({
      where: { id: pending.driverId },
    });
    assert.equal(driver.verificationStatus, 'REJECTED');
  });

  it('blocks support from approve without drivers:verify', async () => {
    const support = await loginStaff(SUPPORT_PHONE, 'support', 'support-app@zaroorat.test');
    const pending = await seedPendingApplication(true);

    const driversRead = await db().client.permission.findUniqueOrThrow({
      where: { code: 'drivers:read' },
    });
    const supportRole = await db().client.role.findUniqueOrThrow({ where: { slug: 'support' } });
    await db().client.rolePermission.upsert({
      where: {
        roleId_permissionId: { roleId: supportRole.id, permissionId: driversRead.id },
      },
      create: { roleId: supportRole.id, permissionId: driversRead.id, effect: 'ALLOW' },
      update: {},
    });

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/applications',
      headers: support.authHeader,
    });
    assert.equal(listed.statusCode, 200, listed.payload);

    const approved = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/applications/${pending.driverId}/approve`,
      headers: support.authHeader,
      payload: { notes: 'Should fail' },
    });
    assert.equal(approved.statusCode, 403, approved.payload);
  });
});

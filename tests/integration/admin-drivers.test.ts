import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { grantRole, makeDriver } from './helpers/fixtures.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';

const ADMIN_PHONE = '+919876543001';
const DRIVER_PHONE = '+919876543002';
const SUPPORT_PHONE = '+919876543003';
const ADMIN_EMAIL = 'driver-admin@zaroorat.test';
const ADMIN_PASSWORD = 'Admin@12345';

describe('admin drivers (integration)', () => {
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

  async function seedDriverUser() {
    const user = await loginAs(app, DRIVER_PHONE);
    await grantRole(user.userId, 'driver');
    await db().client.userProfile.upsert({
      where: { userId: user.userId },
      create: { userId: user.userId, firstName: 'Rajesh', lastName: 'Kumar' },
      update: { firstName: 'Rajesh', lastName: 'Kumar' },
    });
    const driverId = await makeDriver(user.userId, { verified: true });
    await db().client.driverProfile.create({
      data: {
        driverId,
        fullLegalName: 'Rajesh Kumar',
        city: 'Srinagar',
        state: 'Jammu & Kashmir',
      },
    });
    await db().client.driverWallet.create({
      data: { driverId, balance: 1250, lockedBalance: 0 },
    });
    return { ...user, driverId };
  }

  it('lists drivers and returns detail for staff with drivers:read', async () => {
    const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
    const driver = await seedDriverUser();

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/drivers',
      headers: admin.authHeader,
    });
    assert.equal(listed.statusCode, 200, listed.payload);
    const match = listed.json().data.find((row: { id: string }) => row.id === driver.driverId);
    assert.ok(match);
    assert.equal(match.driverName, 'Rajesh Kumar');
    assert.equal(match.walletBalance, 1250);
    assert.equal(match.isSuspended, false);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/drivers/${driver.driverId}`,
      headers: admin.authHeader,
    });
    assert.equal(detail.statusCode, 200, detail.payload);
    const body = detail.json().data;
    assert.equal(body.id, driver.driverId);
    assert.ok(Array.isArray(body.documents));
    assert.ok(body.documents.length >= 1);
    assert.ok(Array.isArray(body.timeline));
  });

  it('suspends, blocks, and activates a driver with drivers:write', async () => {
    const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
    const driver = await seedDriverUser();

    const suspended = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/drivers/${driver.driverId}/suspend`,
      headers: admin.authHeader,
      payload: { notes: 'Safety review' },
    });
    assert.equal(suspended.statusCode, 200, suspended.payload);
    assert.equal(suspended.json().data.driverStatus, 'suspended');
    assert.equal(suspended.json().data.isSuspended, true);
    assert.equal(suspended.json().data.isBlocked, false);

    const row = await db().client.driver.findUniqueOrThrow({ where: { id: driver.driverId } });
    assert.equal(row.isSuspended, true);
    const suspendedUser = await db().client.user.findUniqueOrThrow({
      where: { id: driver.userId },
    });
    assert.equal(suspendedUser.status, 'SUSPENDED');

    const blocked = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/drivers/${driver.driverId}/block`,
      headers: admin.authHeader,
      payload: { notes: 'Fraud' },
    });
    assert.equal(blocked.statusCode, 200, blocked.payload);
    assert.equal(blocked.json().data.driverStatus, 'blocked');
    assert.equal(blocked.json().data.isBlocked, true);

    const blockedUser = await db().client.user.findUniqueOrThrow({ where: { id: driver.userId } });
    assert.equal(blockedUser.status, 'DEACTIVATED');

    const activated = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/drivers/${driver.driverId}/activate`,
      headers: admin.authHeader,
      payload: { notes: 'Cleared' },
    });
    assert.equal(activated.statusCode, 200, activated.payload);
    assert.equal(activated.json().data.isSuspended, false);
    assert.equal(activated.json().data.isBlocked, false);
    assert.notEqual(activated.json().data.driverStatus, 'blocked');
    assert.notEqual(activated.json().data.driverStatus, 'suspended');

    const activeUser = await db().client.user.findUniqueOrThrow({ where: { id: driver.userId } });
    assert.equal(activeUser.status, 'ACTIVE');
  });

  it('keeps support read-only off write actions when lacking drivers:write', async () => {
    const support = await loginStaff(SUPPORT_PHONE, 'support', 'support-drv@zaroorat.test');
    const driver = await seedDriverUser();

    // Support seed role does not include drivers:read by default — grant it.
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

    // Re-login so permissions refresh... authorize loads live from DB so no need.
    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/drivers',
      headers: support.authHeader,
    });
    assert.equal(listed.statusCode, 200, listed.payload);

    const denied = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/drivers/${driver.driverId}/suspend`,
      headers: support.authHeader,
      payload: { notes: 'nope' },
    });
    assert.equal(denied.statusCode, 403);
  });

  it('refuses driver management for a customer token', async () => {
    const customer = await loginAs(app, DRIVER_PHONE);
    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/drivers',
      headers: customer.authHeader,
    });
    assert.equal(listed.statusCode, 403);
  });
});

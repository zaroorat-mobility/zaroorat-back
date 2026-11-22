import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { grantRole } from './helpers/fixtures.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';

const SYSTEM_PHONE = '+919876541001';
const SUPPORT_PHONE = '+919876541002';
const FINANCE_PHONE = '+919876541003';
const SYSTEM_EMAIL = 'rbac-system@zaroorat.test';
const SYSTEM_PASSWORD = 'Admin@12345';

describe('admin RBAC (integration)', () => {
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

  async function loginWithRole(phone: string, role: string, email?: string) {
    const seed = await loginAs(app, phone);
    await grantRole(seed.userId, role);
    if (!email) return loginAs(app, phone);
    await db().client.user.update({
      where: { id: seed.userId },
      data: {
        email,
        passwordHash: hashPassword(SYSTEM_PASSWORD),
        isEmailVerified: true,
      },
    });
    const loggedIn = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/admin/login',
      payload: { email, password: SYSTEM_PASSWORD },
    });
    if (loggedIn.statusCode !== 200) {
      throw new Error(`staff login failed: ${loggedIn.payload}`);
    }
    const body = loggedIn.json();
    return {
      userId: body.user.id as string,
      authHeader: { authorization: `Bearer ${body.accessToken}` },
      permissions: body.user.permissions as string[],
      roles: body.user.roles as string[],
    };
  }

  it('lets system_admin list roles and grant riders:read to support', async () => {
    const systemAdmin = await loginWithRole(SYSTEM_PHONE, 'system_admin', SYSTEM_EMAIL);
    assert.ok((systemAdmin as { permissions: string[] }).permissions.includes('rbac:manage'));
    assert.ok((systemAdmin as { roles: string[] }).roles.includes('system_admin'));

    const catalog = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/rbac/permissions',
      headers: systemAdmin.authHeader,
    });
    assert.equal(catalog.statusCode, 200, catalog.payload);
    const codes = catalog.json().data.map((row: { code: string }) => row.code);
    assert.ok(codes.includes('riders:read'));
    assert.ok(codes.includes('rbac:manage'));

    const roles = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/rbac/roles',
      headers: systemAdmin.authHeader,
    });
    assert.equal(roles.statusCode, 200, roles.payload);
    const slugs = roles.json().data.map((row: { slug: string }) => row.slug);
    assert.ok(['admin', 'finance', 'support'].every((slug) => slugs.includes(slug)));
    assert.ok(!slugs.includes('system_admin'));

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/rbac/roles',
      headers: systemAdmin.authHeader,
      payload: {
        name: `Operations ${randomUUID().slice(0, 8)}`,
        permissionCodes: ['riders:read'],
      },
    });
    assert.equal(created.statusCode, 201, created.payload);
    const createdSlug = created.json().data.slug as string;
    assert.match(createdSlug, /^operations_/);
    assert.deepEqual(created.json().data.permissionCodes, ['riders:read']);

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/rbac/roles',
      headers: systemAdmin.authHeader,
    });
    const listedSlugs = listed.json().data.map((row: { slug: string }) => row.slug);
    assert.ok(listedSlugs.includes(createdSlug));

    const reserved = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/rbac/roles',
      headers: systemAdmin.authHeader,
      payload: { name: 'System Admin' },
    });
    assert.equal(reserved.statusCode, 403);

    const lockedCreate = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/rbac/roles',
      headers: systemAdmin.authHeader,
      payload: { name: `Auditor ${randomUUID().slice(0, 8)}`, permissionCodes: ['staff:write'] },
    });
    assert.equal(lockedCreate.statusCode, 403);

    const granted = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/rbac/roles/support/permissions',
      headers: systemAdmin.authHeader,
      payload: { permissionCodes: ['riders:read', 'safety:read'] },
    });
    assert.equal(granted.statusCode, 200, granted.payload);
    assert.deepEqual(granted.json().data.permissionCodes.sort(), ['riders:read', 'safety:read']);
  });

  it('keeps support off driver verify and RBAC/staff writes until granted', async () => {
    const systemAdmin = await loginWithRole(SYSTEM_PHONE, 'system_admin', SYSTEM_EMAIL);
    const support = await loginWithRole(SUPPORT_PHONE, 'support');
    const driverId = randomUUID();

    const deniedVerify = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/drivers/${driverId}/verify`,
      headers: support.authHeader,
      payload: { status: 'VERIFIED' },
    });
    assert.equal(deniedVerify.statusCode, 403, deniedVerify.payload);

    const deniedRbac = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/rbac/roles/finance/permissions',
      headers: support.authHeader,
      payload: { permissionCodes: ['finance:read'] },
    });
    assert.equal(deniedRbac.statusCode, 403);

    const deniedStaff = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: support.authHeader,
      payload: {
        firstName: 'No',
        lastName: 'Access',
        email: 'nope@zaroorat.test',
        phoneNumber: '+919876541099',
        password: 'Support@12345',
        role: 'support',
      },
    });
    assert.equal(deniedStaff.statusCode, 403);

    const locked = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/rbac/roles/support/permissions',
      headers: systemAdmin.authHeader,
      payload: { permissionCodes: ['drivers:verify', 'staff:write'] },
    });
    assert.equal(locked.statusCode, 403, locked.payload);

    const granted = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/rbac/roles/support/permissions',
      headers: systemAdmin.authHeader,
      payload: { permissionCodes: ['drivers:verify'] },
    });
    assert.equal(granted.statusCode, 200, granted.payload);

    const allowedVerify = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/drivers/${driverId}/verify`,
      headers: support.authHeader,
      payload: { status: 'VERIFIED' },
    });
    assert.notEqual(allowedVerify.statusCode, 403, allowedVerify.payload);
  });

  it('lets finance hit payouts but not rider-staff routes by default', async () => {
    const finance = await loginWithRole(FINANCE_PHONE, 'finance');

    const staff = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: finance.authHeader,
    });
    assert.equal(staff.statusCode, 403);

    const ridersDenied = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/drivers/${randomUUID()}/verify`,
      headers: finance.authHeader,
      payload: { status: 'VERIFIED' },
    });
    assert.equal(ridersDenied.statusCode, 403);

    const payout = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/payments/payouts',
      headers: finance.authHeader,
      payload: { driverId: randomUUID(), settlementId: randomUUID(), amount: 1 },
    });
    assert.notEqual(payout.statusCode, 403, payout.payload);
  });
});

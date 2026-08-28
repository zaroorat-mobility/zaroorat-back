import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { grantRole } from './helpers/fixtures.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';

const ADMIN_PHONE = '+919876542001';
const RIDER_PHONE = '+919876542002';
const SUPPORT_PHONE = '+919876542003';
const ADMIN_EMAIL = 'rider-admin@zaroorat.test';
const ADMIN_PASSWORD = 'Admin@12345';

describe('admin riders (integration)', () => {
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

  async function seedRider() {
    const rider = await loginAs(app, RIDER_PHONE);
    await db().client.userProfile.upsert({
      where: { userId: rider.userId },
      create: { userId: rider.userId, firstName: 'Aamina', lastName: 'Jan' },
      update: { firstName: 'Aamina', lastName: 'Jan' },
    });
    await db().client.emergencyContact.create({
      data: {
        userId: rider.userId,
        contactName: 'Father',
        phoneNumber: '+919876542099',
        relationship: 'parent',
        priority: 1,
      },
    });
    await db().client.customerWallet.create({
      data: { userId: rider.userId, balance: 250, lockedBalance: 0 },
    });
    return rider;
  }

  it('lists riders and returns detail for staff with riders:read', async () => {
    const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
    const rider = await seedRider();

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/riders',
      headers: admin.authHeader,
    });
    assert.equal(listed.statusCode, 200, listed.payload);
    const listBody = listed.json();
    assert.ok(listBody.data.some((row: { id: string }) => row.id === rider.userId));
    const match = listBody.data.find((row: { id: string }) => row.id === rider.userId);
    assert.equal(match.fullName, 'Aamina Jan');
    assert.equal(match.riderStatus, 'active');
    assert.equal(match.walletBalance, 250);
    assert.equal(match.emergencyContacts.length, 1);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/riders/${rider.userId}`,
      headers: admin.authHeader,
    });
    assert.equal(detail.statusCode, 200, detail.payload);
    const riderDetail = detail.json().data;
    assert.equal(riderDetail.id, rider.userId);
    assert.equal(riderDetail.fullName, 'Aamina Jan');
    assert.ok(Array.isArray(riderDetail.rideHistory));
    assert.ok(Array.isArray(riderDetail.ledger));
    assert.ok(Array.isArray(riderDetail.timeline));
    assert.ok(
      riderDetail.timeline.some((evt: { action: string }) => evt.action.includes('Created')),
    );
  });

  it('suspends, blocks, and activates a rider with riders:write', async () => {
    const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
    const rider = await seedRider();

    const suspended = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/riders/${rider.userId}/suspend`,
      headers: admin.authHeader,
      payload: { notes: 'Too many cancellations' },
    });
    assert.equal(suspended.statusCode, 200, suspended.payload);
    assert.equal(suspended.json().data.riderStatus, 'suspended');

    const userAfterSuspend = await db().client.user.findUniqueOrThrow({
      where: { id: rider.userId },
    });
    assert.equal(userAfterSuspend.status, 'SUSPENDED');

    const blocked = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/riders/${rider.userId}/block`,
      headers: admin.authHeader,
      payload: { notes: 'Fraud review' },
    });
    assert.equal(blocked.statusCode, 200, blocked.payload);
    assert.equal(blocked.json().data.riderStatus, 'blocked');

    const activated = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/riders/${rider.userId}/activate`,
      headers: admin.authHeader,
      payload: { notes: 'Cleared after review' },
    });
    assert.equal(activated.statusCode, 200, activated.payload);
    assert.equal(activated.json().data.riderStatus, 'active');
    assert.ok(
      activated
        .json()
        .data.timeline.some(
          (evt: { action: string; notes?: string }) =>
            evt.action.includes('Activated') || evt.notes?.includes('Cleared'),
        ),
    );
  });

  it('lets support read riders but not change status', async () => {
    const support = await loginStaff(SUPPORT_PHONE, 'support', 'support-rider@zaroorat.test');
    const rider = await seedRider();

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/riders',
      headers: support.authHeader,
    });
    assert.equal(listed.statusCode, 200, listed.payload);

    const denied = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/riders/${rider.userId}/suspend`,
      headers: support.authHeader,
      payload: { notes: 'nope' },
    });
    assert.equal(denied.statusCode, 403);
  });

  it('refuses rider management for a customer token', async () => {
    const customer = await loginAs(app, RIDER_PHONE);
    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/riders',
      headers: customer.authHeader,
    });
    assert.equal(listed.statusCode, 403);
  });

  it('returns 404 for unknown rider ids', async () => {
    const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
    const missing = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/riders/00000000-0000-7000-8000-000000000099',
      headers: admin.authHeader,
    });
    assert.equal(missing.statusCode, 404);
  });
});

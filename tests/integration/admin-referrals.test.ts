import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { grantRole } from './helpers/fixtures.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';

const ADMIN_PHONE = '+919876545201';
const ADMIN_EMAIL = 'referral-admin@zaroorat.test';
const ADMIN_PASSWORD = 'Admin@12345';

describe('admin referral & rewards (integration)', () => {
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

  async function loginAdmin() {
    const seed = await loginAs(app, ADMIN_PHONE);
    await grantRole(seed.userId, 'system_admin');
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
    assert.equal(loggedIn.statusCode, 200, loggedIn.payload);
    return {
      authorization: `Bearer ${loggedIn.json().accessToken}`,
      adminUserId: seed.userId,
    };
  }

  it('creates referral program with rewards, eligibility, caps and expiry', async () => {
    const authHeader = await loginAdmin();
    const now = new Date();
    const later = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/referral-programs',
      headers: authHeader,
      payload: {
        code: 'REFTST01',
        name: 'Test referral',
        referrerReward: 50,
        refereeReward: 40,
        rewardType: 'WALLET',
        qualifyingEvent: 'FIRST_RIDE',
        qualifyingThreshold: 1,
        maxReferralsPerUser: 10,
        rewardExpiryDays: 30,
        validFrom: now.toISOString(),
        validTo: later.toISOString(),
        isActive: true,
      },
    });
    assert.equal(created.statusCode, 201, created.payload);
    const program = created.json().data;
    assert.equal(program.code, 'REFTST01');
    assert.equal(program.referrerReward, 50);
    assert.equal(program.refereeReward, 40);
    assert.equal(program.qualifyingEvent, 'FIRST_RIDE');
    assert.equal(program.audience, 'RIDER');
    assert.equal(program.rewardWallet, 'CUSTOMER');
    assert.equal(program.maxReferralsPerUser, 10);
    assert.equal(program.rewardExpiryDays, 30);

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/referral-programs',
      headers: authHeader,
    });
    assert.equal(listed.statusCode, 200, listed.payload);
    assert.ok(listed.json().data.some((row: { id: string }) => row.id === program.id));

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/referral-programs/${program.id}`,
      headers: authHeader,
      payload: {
        referrerReward: 75,
        refereeReward: 60,
        maxReferralsPerUser: 20,
      },
    });
    assert.equal(patched.statusCode, 200, patched.payload);
    assert.equal(patched.json().data.referrerReward, 75);
    assert.equal(patched.json().data.refereeReward, 60);
    assert.equal(patched.json().data.maxReferralsPerUser, 20);
  });

  it('activates/deactivates program and milestones', async () => {
    const authHeader = await loginAdmin();
    const now = new Date();
    const later = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/referral-programs',
      headers: authHeader,
      payload: {
        name: 'Milestone program',
        referrerReward: 25,
        refereeReward: 25,
        validFrom: now.toISOString(),
        validTo: later.toISOString(),
      },
    });
    assert.equal(created.statusCode, 201, created.payload);
    const programId = created.json().data.id;

    const milestoneRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/referral-programs/${programId}/milestones`,
      headers: authHeader,
      payload: {
        name: '5 friends',
        requiredReferrals: 5,
        bonusAmount: 100,
      },
    });
    assert.equal(milestoneRes.statusCode, 201, milestoneRes.payload);
    const milestoneId = milestoneRes.json().data.id;
    assert.equal(milestoneRes.json().data.isActive, true);

    const milestoneOff = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/referral-milestones/${milestoneId}/deactivate`,
      headers: authHeader,
    });
    assert.equal(milestoneOff.statusCode, 200, milestoneOff.payload);
    assert.equal(milestoneOff.json().data.isActive, false);

    const milestoneOn = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/referral-milestones/${milestoneId}/activate`,
      headers: authHeader,
    });
    assert.equal(milestoneOn.statusCode, 200, milestoneOn.payload);
    assert.equal(milestoneOn.json().data.isActive, true);

    const programOff = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/referral-programs/${programId}/deactivate`,
      headers: authHeader,
    });
    assert.equal(programOff.statusCode, 200, programOff.payload);
    assert.equal(programOff.json().data.isActive, false);

    const programOn = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/referral-programs/${programId}/activate`,
      headers: authHeader,
    });
    assert.equal(programOn.statusCode, 200, programOn.payload);
    assert.equal(programOn.json().data.isActive, true);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/referral-programs/${programId}`,
      headers: authHeader,
    });
    assert.equal(detail.statusCode, 200, detail.payload);
    assert.equal(detail.json().data.milestones.length, 1);
    assert.equal(detail.json().data.milestones[0].isActive, true);
  });

  it('lists referral codes and history', async () => {
    const { authorization, adminUserId } = await loginAdmin();
    const authHeader = { authorization };
    const now = new Date();
    const later = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const programRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/referral-programs',
      headers: authHeader,
      payload: {
        code: 'REFHIST',
        name: 'History program',
        referrerReward: 50,
        refereeReward: 50,
        validFrom: now.toISOString(),
        validTo: later.toISOString(),
      },
    });
    assert.equal(programRes.statusCode, 201, programRes.payload);
    const programId = programRes.json().data.id;

    const referee = await loginAs(app, '+919876545202');

    const code = await db().client.referralCode.create({
      data: {
        userId: adminUserId,
        programId,
        code: 'ADMINREF1',
        usesCount: 1,
        maxUses: 10,
        isActive: true,
      },
    });

    const referral = await db().client.referral.create({
      data: {
        programId,
        referrerId: adminUserId,
        refereeId: referee.userId,
        referralCodeId: code.id,
        status: 'SIGNED_UP',
        qualifyingRides: 0,
        signedUpAt: now,
        expiresAt: later,
      },
    });

    await db().client.referralReward.create({
      data: {
        referralId: referral.id,
        beneficiary: 'REFERRER',
        userId: adminUserId,
        amount: 50,
        rewardType: 'WALLET',
        status: 'PENDING',
      },
    });

    const codesRes = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/referral-codes?programId=${programId}`,
      headers: authHeader,
    });
    assert.equal(codesRes.statusCode, 200, codesRes.payload);
    assert.equal(codesRes.json().data.length, 1);
    assert.equal(codesRes.json().data[0].code, 'ADMINREF1');

    const codeOff = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/referral-codes/${code.id}/deactivate`,
      headers: authHeader,
    });
    assert.equal(codeOff.statusCode, 200, codeOff.payload);
    assert.equal(codeOff.json().data.isActive, false);

    const historyRes = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/referrals?programId=${programId}`,
      headers: authHeader,
    });
    assert.equal(historyRes.statusCode, 200, historyRes.payload);
    assert.equal(historyRes.json().data.length, 1);
    assert.equal(historyRes.json().data[0].status, 'SIGNED_UP');
    assert.equal(historyRes.json().data[0].rewards.length, 1);
    assert.equal(historyRes.json().data[0].rewards[0].beneficiary, 'REFERRER');

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/referrals/${referral.id}`,
      headers: authHeader,
    });
    assert.equal(detail.statusCode, 200, detail.payload);
    assert.equal(detail.json().data.referralCode, 'ADMINREF1');
  });

  it('creates driver recruitment program with DRIVER audience and wallet', async () => {
    const authHeader = await loginAdmin();
    const now = new Date();
    const later = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/referral-programs',
      headers: authHeader,
      payload: {
        code: 'REFDRV01',
        name: 'Driver recruit',
        audience: 'DRIVER',
        referrerReward: 500,
        refereeReward: 200,
        rewardWallet: 'DRIVER',
        qualifyingEvent: 'DRIVER_APPROVED',
        qualifyingThreshold: 1,
        validFrom: now.toISOString(),
        validTo: later.toISOString(),
      },
    });
    assert.equal(created.statusCode, 201, created.payload);
    const program = created.json().data;
    assert.equal(program.audience, 'DRIVER');
    assert.equal(program.rewardWallet, 'DRIVER');
    assert.equal(program.qualifyingEvent, 'DRIVER_APPROVED');

    const riderOnly = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/referral-programs',
      headers: authHeader,
      payload: {
        code: 'BAD_MIX',
        audience: 'RIDER',
        rewardWallet: 'DRIVER',
        qualifyingEvent: 'FIRST_RIDE',
        validFrom: now.toISOString(),
        validTo: later.toISOString(),
      },
    });
    assert.equal(riderOnly.statusCode, 400, riderOnly.payload);

    const filtered = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/referral-programs?audience=DRIVER',
      headers: authHeader,
    });
    assert.equal(filtered.statusCode, 200, filtered.payload);
    assert.ok(filtered.json().data.every((row: { audience: string }) => row.audience === 'DRIVER'));
    assert.ok(filtered.json().data.some((row: { id: string }) => row.id === program.id));
  });
});

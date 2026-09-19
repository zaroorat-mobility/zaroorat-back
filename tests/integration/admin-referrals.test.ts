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

  it('creates a non-monetary rider program with eligibility, caps and expiry', async () => {
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
    assert.equal(program.referrerReward, 0);
    assert.equal(program.refereeReward, 0);
    assert.equal(program.qualifyingEvent, 'FIRST_RIDE');
    assert.equal(program.audience, 'RIDER');
    assert.equal(program.rewardWallet, null, 'a rider program has no reward wallet');
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
      payload: { maxReferralsPerUser: 20 },
    });
    assert.equal(patched.statusCode, 200, patched.payload);
    assert.equal(patched.json().data.maxReferralsPerUser, 20);
  });

  it('rejects any monetary or wallet configuration on a RIDER program', async () => {
    const authHeader = await loginAdmin();
    const now = new Date();
    const later = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
    const validity = { validFrom: now.toISOString(), validTo: later.toISOString() };
    const createRider = (payload: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/admin/referral-programs',
        headers: authHeader,
        payload: { audience: 'RIDER', ...validity, ...payload },
      });

    for (const payload of [
      { code: 'RIDCUST', rewardWallet: 'CUSTOMER' },
      { code: 'RIDCUST2', rewardWallet: 'CUSTOMER', referrerReward: 50, refereeReward: 40 },
      { code: 'RIDDRV', rewardWallet: 'DRIVER' },
      { code: 'RIDAMT', referrerReward: 50 },
      { code: 'RIDAMT2', refereeReward: 40 },
    ]) {
      const response = await createRider(payload);
      assert.equal(response.statusCode, 400, `${payload.code}: ${response.payload}`);
    }
    assert.equal(
      await db().client.referralProgram.count({ where: { audience: 'RIDER' } }),
      0,
      'none of them was stored',
    );

    const ok = await createRider({ code: 'RIDOK' });
    assert.equal(ok.statusCode, 201, ok.payload);
    const programId = ok.json().data.id;

    for (const payload of [
      { rewardWallet: 'CUSTOMER' },
      { rewardWallet: 'DRIVER' },
      { referrerReward: 75 },
      { refereeReward: 60 },
    ]) {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/referral-programs/${programId}`,
        headers: authHeader,
        payload,
      });
      assert.equal(response.statusCode, 409, `${JSON.stringify(payload)}: ${response.payload}`);
    }

    const milestone = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/referral-programs/${programId}/milestones`,
      headers: authHeader,
      payload: { name: '5 friends', requiredReferrals: 5, bonusAmount: 100 },
    });
    assert.equal(milestone.statusCode, 409, milestone.payload);

    const stored = await db().client.referralProgram.findUniqueOrThrow({
      where: { id: programId },
      include: { milestones: true },
    });
    assert.equal(Number(stored.referrerReward), 0);
    assert.equal(Number(stored.refereeReward), 0);
    assert.equal(stored.milestones.length, 0);
  });

  it('can still deactivate a legacy monetary rider program', async () => {
    const authHeader = await loginAdmin();
    const now = new Date();
    const legacy = await db().client.referralProgram.create({
      data: {
        code: 'LEGACYRID',
        audience: 'RIDER',
        referrerReward: 50,
        refereeReward: 50,
        rewardWallet: 'CUSTOMER',
        qualifyingEvent: 'FIRST_RIDE',
        validFrom: now,
        validTo: new Date(now.getTime() + 86400000),
        isActive: true,
      },
    });

    const off = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/referral-programs/${legacy.id}/deactivate`,
      headers: authHeader,
    });
    assert.equal(off.statusCode, 200, off.payload);
    assert.equal(off.json().data.isActive, false);
    assert.equal(off.json().data.rewardWallet, null);

    const on = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/referral-programs/${legacy.id}/activate`,
      headers: authHeader,
    });
    assert.equal(on.statusCode, 409, 'it cannot go live again while it carries amounts');
  });

  it('keeps historical rider referral rewards and their wallet credits readable', async () => {
    const authHeader = await loginAdmin();
    const now = new Date();

    // Legacy data as it exists in production: a RIDER program paying the
    // customer wallet, a REWARDED referral, and the CREDITED reward row whose
    // wallet transaction it points at.
    const program = await db().client.referralProgram.create({
      data: {
        code: 'OLDRID',
        audience: 'RIDER',
        referrerReward: 50,
        refereeReward: 0,
        rewardWallet: 'CUSTOMER',
        qualifyingEvent: 'FIRST_RIDE',
        validFrom: new Date(now.getTime() - 86400000),
        validTo: new Date(now.getTime() + 86400000),
        isActive: false,
      },
    });
    const referrer = await loginAs(app, '+919876545203');
    const referee = await loginAs(app, '+919876545204');
    const referral = await db().client.referral.create({
      data: {
        programId: program.id,
        referrerId: referrer.userId,
        refereeId: referee.userId,
        status: 'REWARDED',
        qualifyingRides: 1,
        signedUpAt: now,
        qualifiedAt: now,
        rewardedAt: now,
      },
    });
    const wallet = await db().client.customerWallet.create({
      data: { userId: referrer.userId, balance: 50, lockedBalance: 0, currency: 'INR' },
    });
    const txn = await db().client.customerWalletTransaction.create({
      data: {
        walletId: wallet.id,
        userId: referrer.userId,
        txnType: 'REFERRAL',
        amount: 50,
        balanceAfter: 50,
        referenceType: 'REFERRAL',
      },
    });
    await db().client.referralReward.create({
      data: {
        referralId: referral.id,
        beneficiary: 'REFERRER',
        userId: referrer.userId,
        amount: 50,
        status: 'CREDITED',
        walletTransactionId: txn.id,
        creditedAt: now,
      },
    });

    const history = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/referrals?programId=${program.id}`,
      headers: authHeader,
    });
    assert.equal(history.statusCode, 200, history.payload);
    const row = history.json().data[0];
    assert.equal(row.status, 'REWARDED');
    assert.equal(row.rewards.length, 1);
    assert.equal(row.rewards[0].status, 'CREDITED');
    assert.equal(row.rewards[0].amount, 50);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/referrals/${referral.id}`,
      headers: authHeader,
    });
    assert.equal(detail.statusCode, 200, detail.payload);
    assert.equal(detail.json().data.rewards[0].status, 'CREDITED');

    const programDetail = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/referral-programs/${program.id}`,
      headers: authHeader,
    });
    assert.equal(programDetail.statusCode, 200, programDetail.payload);
    assert.equal(programDetail.json().data.referrerReward, 50, 'legacy amount still shown');

    const balance = await app.inject({
      method: 'GET',
      url: '/api/v1/payments/wallet/balance',
      headers: referrer.authHeader,
    });
    assert.equal(balance.statusCode, 200, balance.payload);
    assert.equal(balance.json().data.balance, 50, 'the historical credit is still readable');
    assert.equal(balance.json().data.id, wallet.id);

    const untouched = await db().client.customerWalletTransaction.findUniqueOrThrow({
      where: { id: txn.id },
    });
    assert.equal(Number(untouched.amount), 50);
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
        audience: 'DRIVER',
        referrerReward: 25,
        refereeReward: 25,
        rewardWallet: 'DRIVER',
        qualifyingEvent: 'DRIVER_APPROVED',
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

  /// Zod 4 applies `.default()` even inside `.partial()`, so the update schemas
  /// used to fill every omitted field with its CREATE default. These pin PATCH
  /// to "only what the caller sent".
  describe('PATCH changes only the fields it is sent', () => {
    const DAY = 24 * 60 * 60 * 1000;

    /// Every stored column a PATCH could clobber, as comparable plain values.
    async function programRow(id: string) {
      const row = await db().client.referralProgram.findUniqueOrThrow({ where: { id } });
      return {
        code: row.code,
        name: row.name,
        audience: row.audience,
        referrerReward: Number(row.referrerReward),
        refereeReward: Number(row.refereeReward),
        rewardType: row.rewardType,
        rewardWallet: row.rewardWallet,
        qualifyingEvent: row.qualifyingEvent,
        qualifyingThreshold: row.qualifyingThreshold,
        maxReferralsPerUser: row.maxReferralsPerUser,
        qualificationWindowDays: row.qualificationWindowDays,
        rewardExpiryDays: row.rewardExpiryDays,
        validFrom: row.validFrom.toISOString(),
        validTo: row.validTo.toISOString(),
        isActive: row.isActive,
      };
    }

    async function milestoneRow(id: string) {
      const row = await db().client.referralMilestone.findUniqueOrThrow({ where: { id } });
      return {
        name: row.name,
        requiredReferrals: row.requiredReferrals,
        bonusAmount: Number(row.bonusAmount),
        rewardType: row.rewardType,
        isActive: row.isActive,
      };
    }

    async function patch(
      authHeader: Record<string, string>,
      url: string,
      payload: Record<string, unknown>,
    ) {
      return app.inject({ method: 'PATCH', url, headers: authHeader, payload });
    }

    /// An inactive DRIVER program with every optional field set away from its
    /// CREATE default, so a default leaking into PATCH would show as a change.
    async function driverProgram(authHeader: Record<string, string>) {
      const now = Date.now();
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/referral-programs',
        headers: authHeader,
        payload: {
          code: 'DRVPATCH',
          name: 'Driver patch',
          audience: 'DRIVER',
          referrerReward: 500,
          refereeReward: 200,
          rewardType: 'CREDIT',
          rewardWallet: 'DRIVER',
          qualifyingEvent: 'DRIVER_NTH_RIDE',
          qualifyingThreshold: 5,
          maxReferralsPerUser: 7,
          qualificationWindowDays: 45,
          validFrom: new Date(now - DAY).toISOString(),
          validTo: new Date(now + 30 * DAY).toISOString(),
          isActive: false,
        },
      });
      assert.equal(created.statusCode, 201, created.payload);
      return created.json().data.id as string;
    }

    it('A–E: a one-field PATCH on a DRIVER program leaves every other field unchanged', async () => {
      const authHeader = await loginAdmin();
      const id = await driverProgram(authHeader);
      const before = await programRow(id);
      const url = `/api/v1/admin/referral-programs/${id}`;

      const renamed = await patch(authHeader, url, { name: 'Renamed' });
      assert.equal(renamed.statusCode, 200, renamed.payload);
      assert.deepEqual(await programRow(id), { ...before, name: 'Renamed' });

      // An empty PATCH is a no-op, not a reset to CREATE defaults.
      const empty = await patch(authHeader, url, {});
      assert.equal(empty.statusCode, 200, empty.payload);
      assert.deepEqual(await programRow(id), { ...before, name: 'Renamed' });

      const capped = await patch(authHeader, url, { maxReferralsPerUser: 9 });
      assert.equal(capped.statusCode, 200, capped.payload);
      const after = await programRow(id);
      assert.deepEqual(after, { ...before, name: 'Renamed', maxReferralsPerUser: 9 });
      assert.equal(after.audience, 'DRIVER', 'B: audience not reset to RIDER');
      assert.equal(after.referrerReward, 500, 'C: referrer amount not reset to 0');
      assert.equal(after.refereeReward, 200, 'C: referee amount not reset to 0');
      assert.equal(after.isActive, false, 'D: an inactive program is not re-activated');
      assert.equal(after.rewardWallet, 'DRIVER', 'E: reward wallet unchanged');
      assert.equal(after.rewardType, 'CREDIT');
      assert.equal(after.qualifyingThreshold, 5);
    });

    it('G: DRIVER programs still update, activate and pay normally', async () => {
      const authHeader = await loginAdmin();
      const id = await driverProgram(authHeader);
      const before = await programRow(id);
      const url = `/api/v1/admin/referral-programs/${id}`;

      const amount = await patch(authHeader, url, { referrerReward: 750 });
      assert.equal(amount.statusCode, 200, amount.payload);
      assert.deepEqual(await programRow(id), { ...before, referrerReward: 750 });

      const activated = await patch(authHeader, url, { isActive: true });
      assert.equal(activated.statusCode, 200, activated.payload);
      assert.deepEqual(await programRow(id), { ...before, referrerReward: 750, isActive: true });
      assert.equal(activated.json().data.rewardWallet, 'DRIVER');

      // The DRIVER rules themselves are unchanged.
      for (const payload of [{ rewardWallet: 'CUSTOMER' }, { qualifyingEvent: 'FIRST_RIDE' }]) {
        const refused = await patch(authHeader, url, payload);
        assert.equal(refused.statusCode, 409, `${JSON.stringify(payload)}: ${refused.payload}`);
      }
      assert.deepEqual(await programRow(id), { ...before, referrerReward: 750, isActive: true });
    });

    it('B–E on a RIDER program: omitted fields, including the stored wallet column, stay put', async () => {
      const authHeader = await loginAdmin();
      const now = Date.now();
      // Legacy shape: inactive, still carrying amounts and the CUSTOMER column.
      const legacy = await db().client.referralProgram.create({
        data: {
          code: 'RIDLEGACY',
          audience: 'RIDER',
          referrerReward: 50,
          refereeReward: 30,
          rewardWallet: 'CUSTOMER',
          qualifyingEvent: 'NTH_RIDE',
          qualifyingThreshold: 3,
          validFrom: new Date(now - DAY),
          validTo: new Date(now + DAY),
          isActive: false,
        },
      });
      const before = await programRow(legacy.id);

      const renamed = await patch(authHeader, `/api/v1/admin/referral-programs/${legacy.id}`, {
        name: 'Legacy renamed',
      });
      assert.equal(renamed.statusCode, 200, renamed.payload);
      assert.deepEqual(await programRow(legacy.id), { ...before, name: 'Legacy renamed' });
      assert.equal(renamed.json().data.rewardWallet, null, 'still reported as having no wallet');
    });

    it('F: the RIDER safety rules still apply to PATCH', async () => {
      const authHeader = await loginAdmin();
      const now = Date.now();
      const legacy = await db().client.referralProgram.create({
        data: {
          code: 'RIDSAFE',
          audience: 'RIDER',
          referrerReward: 50,
          refereeReward: 30,
          rewardWallet: 'CUSTOMER',
          qualifyingEvent: 'FIRST_RIDE',
          validFrom: new Date(now - DAY),
          validTo: new Date(now + DAY),
          isActive: false,
        },
      });
      const before = await programRow(legacy.id);
      const url = `/api/v1/admin/referral-programs/${legacy.id}`;

      for (const payload of [
        { rewardWallet: 'CUSTOMER' },
        { rewardWallet: 'DRIVER' },
        // Going live while the stored amounts are non-zero.
        { isActive: true },
        { isActive: true, referrerReward: 0 },
        { isActive: true, referrerReward: 0, refereeReward: 10 },
      ]) {
        const refused = await patch(authHeader, url, payload);
        assert.equal(refused.statusCode, 409, `${JSON.stringify(payload)}: ${refused.payload}`);
      }
      assert.deepEqual(await programRow(legacy.id), before, 'nothing was written');

      // Only once both amounts are zero may it go live.
      const live = await patch(authHeader, url, {
        isActive: true,
        referrerReward: 0,
        refereeReward: 0,
      });
      assert.equal(live.statusCode, 200, live.payload);
      assert.deepEqual(await programRow(legacy.id), {
        ...before,
        referrerReward: 0,
        refereeReward: 0,
        isActive: true,
      });

      // And once live, an amount PATCH is refused.
      const paid = await patch(authHeader, url, { refereeReward: 20 });
      assert.equal(paid.statusCode, 409, paid.payload);
    });

    it('a milestone PATCH changes only the fields it is sent', async () => {
      const authHeader = await loginAdmin();
      const programId = await driverProgram(authHeader);
      const created = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/referral-programs/${programId}/milestones`,
        headers: authHeader,
        payload: {
          name: '5 recruits',
          requiredReferrals: 5,
          bonusAmount: 300,
          rewardType: 'CREDIT',
        },
      });
      assert.equal(created.statusCode, 201, created.payload);
      const id = created.json().data.id as string;
      const url = `/api/v1/admin/referral-milestones/${id}`;

      const off = await patch(authHeader, url, { isActive: false });
      assert.equal(off.statusCode, 200, off.payload);
      const before = await milestoneRow(id);
      assert.equal(before.isActive, false);

      const renamed = await patch(authHeader, url, { name: 'Five recruits' });
      assert.equal(renamed.statusCode, 200, renamed.payload);
      assert.deepEqual(await milestoneRow(id), { ...before, name: 'Five recruits' });

      const empty = await patch(authHeader, url, {});
      assert.equal(empty.statusCode, 200, empty.payload);
      assert.deepEqual(await milestoneRow(id), { ...before, name: 'Five recruits' });
    });

    it('F: a legacy RIDER milestone can be renamed while inactive, but not made live', async () => {
      const authHeader = await loginAdmin();
      const now = Date.now();
      const program = await db().client.referralProgram.create({
        data: {
          code: 'RIDMILE',
          audience: 'RIDER',
          rewardWallet: 'CUSTOMER',
          qualifyingEvent: 'FIRST_RIDE',
          validFrom: new Date(now - DAY),
          validTo: new Date(now + DAY),
          isActive: false,
        },
      });
      const milestone = await db().client.referralMilestone.create({
        data: {
          programId: program.id,
          name: '2 friends',
          requiredReferrals: 2,
          bonusAmount: 75,
          isActive: false,
        },
      });
      const before = await milestoneRow(milestone.id);
      const url = `/api/v1/admin/referral-milestones/${milestone.id}`;

      // Omitting isActive used to default it to true and trip the RIDER rule.
      const renamed = await patch(authHeader, url, { name: 'Two friends' });
      assert.equal(renamed.statusCode, 200, renamed.payload);
      assert.deepEqual(await milestoneRow(milestone.id), { ...before, name: 'Two friends' });

      const live = await patch(authHeader, url, { isActive: true });
      assert.equal(live.statusCode, 409, live.payload);
      assert.equal((await milestoneRow(milestone.id)).isActive, false);
    });
  });
});

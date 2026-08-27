import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import {
  bootApp,
  bootEventConsumers,
  db,
  drainOutbox,
  loginAs,
  resetState,
} from './helpers/harness.js';
import { completeProfile, grantRole, makeDriver } from './helpers/fixtures.js';
import { completeRide, fundWallet, rideWorld } from './helpers/ride-flow.js';
import { driverConfig } from '../../src/config/driver/driver.config.js';
import type { Unsubscribe } from '../../src/core/events/index.js';

const REFERRER = '+919876610001';
const REFEREE = '+919876610002';
const RIDE_DRIVER = '+919876610003';
const DRIVER_REFERRER = '+919876610004';
const DRIVER_REFEREE = '+919876610005';
const ADMIN = '+919876610006';
const MILESTONE_RIDE_DRIVER = '+919876610007';

describe('referral runtime (integration)', () => {
  let app: FastifyInstance;
  let stopConsumers: Unsubscribe;

  before(async () => {
    app = await bootApp();
    stopConsumers = bootEventConsumers();
    await resetState();
  });

  after(async () => {
    stopConsumers();
    await app.close();
  });

  afterEach(async () => {
    await resetState();
  });

  async function seedRiderProgram() {
    const now = new Date();
    const later = new Date(now.getTime() + 90 * 86400000);
    const program = await db().client.referralProgram.create({
      data: {
        code: 'RTRUN01',
        name: 'Rider runtime test',
        audience: 'RIDER',
        referrerReward: 50,
        refereeReward: 30,
        rewardType: 'WALLET',
        rewardWallet: 'CUSTOMER',
        qualifyingEvent: 'FIRST_RIDE',
        qualifyingThreshold: 1,
        maxReferralsPerUser: 20,
        rewardExpiryDays: 60,
        validFrom: now,
        validTo: later,
        isActive: true,
      },
    });
    await db().client.referralMilestone.create({
      data: {
        programId: program.id,
        name: '2 friends',
        requiredReferrals: 2,
        bonusAmount: 75,
        rewardType: 'WALLET',
        isActive: true,
      },
    });
    return program;
  }

  async function seedDriverProgram() {
    const now = new Date();
    const later = new Date(now.getTime() + 90 * 86400000);
    return db().client.referralProgram.create({
      data: {
        code: 'DRVRT01',
        name: 'Driver runtime test',
        audience: 'DRIVER',
        referrerReward: 500,
        refereeReward: 200,
        rewardType: 'WALLET',
        rewardWallet: 'DRIVER',
        qualifyingEvent: 'DRIVER_APPROVED',
        qualifyingThreshold: 1,
        maxReferralsPerUser: 20,
        rewardExpiryDays: 90,
        validFrom: now,
        validTo: later,
        isActive: true,
      },
    });
  }

  async function createReferralCode(userId: string, programId: string, code: string) {
    return db().client.referralCode.create({
      data: { userId, programId, code, maxUses: 20, isActive: true },
    });
  }

  async function loginAdmin() {
    const seed = await loginAs(app, ADMIN);
    await grantRole(seed.userId, 'admin');
    return loginAs(app, ADMIN);
  }

  it('credits customer wallets when a referred rider completes their first ride', async () => {
    await seedRiderProgram();

    const referrerSeed = await loginAs(app, REFERRER);
    await completeProfile(referrerSeed.userId);
    const refereeSeed = await loginAs(app, REFEREE);
    await completeProfile(refereeSeed.userId);

    const program = await db().client.referralProgram.findUniqueOrThrow({
      where: { code: 'RTRUN01' },
    });
    await createReferralCode(referrerSeed.userId, program.id, 'RIDREF01');

    const applied = await app.inject({
      method: 'POST',
      url: '/api/v1/referrals/rider/apply',
      headers: refereeSeed.authHeader,
      payload: { code: 'RIDREF01' },
    });
    assert.equal(applied.statusCode, 201, applied.payload);
    assert.equal(applied.json().data.status, 'SIGNED_UP');

    const world = await rideWorld(app, { customer: REFEREE, driver: RIDE_DRIVER });
    await fundWallet(app, world.customer, 500);
    await completeRide(app, world, { distanceKm: 6, durationMin: 14 });
    await drainOutbox();

    const referral = await db().client.referral.findFirstOrThrow({
      where: { refereeId: refereeSeed.userId, programId: program.id },
    });
    assert.equal(referral.status, 'REWARDED');

    const rewards = await db().client.referralReward.findMany({
      where: { referralId: referral.id },
      orderBy: { beneficiary: 'asc' },
    });
    assert.equal(rewards.length, 2);
    assert.ok(rewards.every((r) => r.status === 'CREDITED'));

    const referrerWallet = await db().client.customerWallet.findUniqueOrThrow({
      where: { userId: referrerSeed.userId },
    });
    const refereeWallet = await db().client.customerWallet.findUniqueOrThrow({
      where: { userId: refereeSeed.userId },
    });
    assert.equal(Number(referrerWallet.balance), 50);
    // Referee wallet was funded with 500 before the qualifying ride.
    assert.equal(Number(refereeWallet.balance), 530);
  });

  it('grants milestone bonus after the second rewarded rider referral', async () => {
    await seedRiderProgram();
    const program = await db().client.referralProgram.findUniqueOrThrow({
      where: { code: 'RTRUN01' },
    });
    const milestone = await db().client.referralMilestone.findFirstOrThrow({
      where: { programId: program.id, name: '2 friends' },
    });

    const referrerSeed = await loginAs(app, REFERRER);
    await completeProfile(referrerSeed.userId);
    const code = await createReferralCode(referrerSeed.userId, program.id, 'RIDREF02');

    const firstReferee = await loginAs(app, REFEREE);
    await completeProfile(firstReferee.userId);
    await db().client.referral.create({
      data: {
        programId: program.id,
        referrerId: referrerSeed.userId,
        refereeId: firstReferee.userId,
        referralCodeId: code.id,
        status: 'REWARDED',
        qualifyingRides: 1,
        signedUpAt: new Date(),
        rewardedAt: new Date(),
      },
    });

    const secondReferee = await loginAs(app, RIDE_DRIVER);
    await completeProfile(secondReferee.userId);
    await app.inject({
      method: 'POST',
      url: '/api/v1/referrals/rider/apply',
      headers: secondReferee.authHeader,
      payload: { code: 'RIDREF02' },
    });

    const world = await rideWorld(app, { customer: RIDE_DRIVER, driver: MILESTONE_RIDE_DRIVER });
    await fundWallet(app, world.customer, 500);
    await completeRide(app, world, { distanceKm: 5, durationMin: 12 });
    await drainOutbox();

    const achievement = await db().client.referralMilestoneAchievement.findUnique({
      where: { milestoneId_userId: { milestoneId: milestone.id, userId: referrerSeed.userId } },
    });
    assert.ok(achievement);

    const milestoneReward = await db().client.referralReward.findFirst({
      where: { userId: referrerSeed.userId, beneficiary: 'MILESTONE' },
    });
    assert.ok(milestoneReward);
    assert.equal(milestoneReward.status, 'CREDITED');
    assert.equal(Number(milestoneReward.amount), 75);

    const referrerWallet = await db().client.customerWallet.findUniqueOrThrow({
      where: { userId: referrerSeed.userId },
    });
    // 50 from second referral + 75 milestone (first was pre-seeded REWARDED without wallet)
    assert.equal(Number(referrerWallet.balance), 125);
  });

  it('credits driver wallets when a referred applicant is verified', async () => {
    await seedDriverProgram();
    const program = await db().client.referralProgram.findUniqueOrThrow({
      where: { code: 'DRVRT01' },
    });

    const referrerSeed = await loginAs(app, DRIVER_REFERRER);
    await grantRole(referrerSeed.userId, 'driver');
    const referrerDriverId = await makeDriver(referrerSeed.userId, { verified: true });
    await createReferralCode(referrerSeed.userId, program.id, 'DRVREF01');

    const refereeSeed = await loginAs(app, DRIVER_REFEREE);
    await grantRole(refereeSeed.userId, 'driver');
    const refereeDriverId = await makeDriver(refereeSeed.userId, { verified: false });

    const applied = await app.inject({
      method: 'POST',
      url: '/api/v1/referrals/driver/apply',
      headers: refereeSeed.authHeader,
      payload: { code: 'DRVREF01' },
    });
    assert.equal(applied.statusCode, 201, applied.payload);

    for (const documentType of driverConfig.requiredDocumentTypes) {
      await db().client.driverDocument.create({
        data: {
          driverId: refereeDriverId,
          documentType,
          verificationStatus: 'VERIFIED',
          fileUrl: `https://example.invalid/${documentType.toLowerCase()}.jpg`,
        },
      });
    }

    const admin = await loginAdmin();
    const verified = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/drivers/${refereeDriverId}/verify`,
      headers: admin.authHeader,
      payload: { status: 'VERIFIED' },
    });
    assert.equal(verified.statusCode, 200, verified.payload);
    await drainOutbox();

    const referral = await db().client.referral.findFirstOrThrow({
      where: { refereeId: refereeSeed.userId, programId: program.id },
    });
    assert.equal(referral.status, 'REWARDED');

    const referrerWallet = await db().client.driverWallet.findFirstOrThrow({
      where: { driverId: referrerDriverId },
    });
    const refereeWallet = await db().client.driverWallet.findFirstOrThrow({
      where: { driverId: refereeDriverId },
    });
    assert.equal(Number(referrerWallet.balance), 500);
    assert.equal(Number(refereeWallet.balance), 200);
  });

  it('exposes rider and driver referral me endpoints with share payload', async () => {
    await seedRiderProgram();
    await seedDriverProgram();

    const rider = await loginAs(app, REFERRER);
    await completeProfile(rider.userId);
    const riderMe = await app.inject({
      method: 'GET',
      url: '/api/v1/referrals/rider/me',
      headers: rider.authHeader,
    });
    assert.equal(riderMe.statusCode, 200, riderMe.payload);
    const riderBody = riderMe.json().data;
    assert.equal(riderBody.audience, 'RIDER');
    assert.ok(riderBody.code);
    assert.ok(riderBody.shareMessage?.includes(riderBody.code));

    const driverUser = await loginAs(app, DRIVER_REFERRER);
    await grantRole(driverUser.userId, 'driver');
    await makeDriver(driverUser.userId, { verified: true });
    const driverMe = await app.inject({
      method: 'GET',
      url: '/api/v1/referrals/driver/me',
      headers: driverUser.authHeader,
    });
    assert.equal(driverMe.statusCode, 200, driverMe.payload);
    const driverBody = driverMe.json().data;
    assert.equal(driverBody.audience, 'DRIVER');
    assert.ok(driverBody.code);
    assert.ok(driverBody.shareMessage?.includes(driverBody.code));
  });
});

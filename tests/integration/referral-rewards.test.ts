import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import './helpers/load-test-env.js';
import { bootApp, db, resetState } from './helpers/harness.js';
import { makeDriver, makeRide, makeRideRequest, makeVehicle } from './helpers/fixtures.js';
import { container } from '../../src/core/di.js';
import { ReferralApplyService } from '../../src/modules/referrals/referral-apply.service.js';
import { ReferralRuntimeService } from '../../src/modules/referrals/referral-runtime.service.js';
import { ReferralPendingRewardSweepJob } from '../../src/modules/referrals/jobs/pending-reward-sweep.job.js';

const DAY = 24 * 60 * 60 * 1000;

/// FR-022 · FR-023 · FR-024 · FR-025 · FR-026 · FR-027 · FR-028 · FR-045.
///
/// The referral module is where fraud goes, and every cap in it was decided by a
/// read: qualification incremented a bare counter, the per-code cap was checked
/// then incremented, and a reward whose wallet was missing was booked as paid.
/// These tests assert the invariants those failures broke.
describe('referral rewards and qualification (integration)', () => {
  let app: FastifyInstance;
  let applyService: ReferralApplyService;
  let runtime: ReferralRuntimeService;
  let sweepJob: ReferralPendingRewardSweepJob;
  let vehicleTypeId: string;
  let driverId: string;
  let vehicleId: string;

  before(async () => {
    app = await bootApp();
    applyService = container.resolve<ReferralApplyService>('referralApplyService');
    runtime = container.resolve<ReferralRuntimeService>('referralRuntimeService');
    sweepJob = container.resolve<ReferralPendingRewardSweepJob>('referralPendingRewardSweepJob');
  });
  after(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetState();
    vehicleTypeId = (await db().client.vehicleType.findFirstOrThrow()).id;
    const driverUser = await makeUser('+919876660001');
    driverId = await makeDriver(driverUser);
    vehicleId = await makeVehicle(vehicleTypeId);
  });
  afterEach(async () => {
    await resetState();
  });

  async function makeUser(phoneNumber: string, createdAt?: Date): Promise<string> {
    const user = await db().client.user.create({
      data: { phoneNumber, ...(createdAt ? { createdAt } : {}) },
    });
    return user.id;
  }

  async function makeProgram(
    overrides: {
      audience?: 'RIDER' | 'DRIVER';
      qualifyingEvent?: 'SIGNUP' | 'FIRST_RIDE' | 'NTH_RIDE' | 'DRIVER_APPROVED';
      qualifyingThreshold?: number;
      referrerReward?: number;
      refereeReward?: number;
      rewardWallet?: 'CUSTOMER' | 'DRIVER';
      maxReferralsPerUser?: number | null;
      isActive?: boolean;
      code?: string;
    } = {},
  ): Promise<string> {
    const row = await db().client.referralProgram.create({
      data: {
        code: overrides.code ?? `PRG${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        audience: overrides.audience ?? 'RIDER',
        qualifyingEvent: overrides.qualifyingEvent ?? 'NTH_RIDE',
        qualifyingThreshold: overrides.qualifyingThreshold ?? 1,
        referrerReward: overrides.referrerReward ?? 100,
        refereeReward: overrides.refereeReward ?? 50,
        rewardWallet: overrides.rewardWallet ?? 'CUSTOMER',
        maxReferralsPerUser:
          overrides.maxReferralsPerUser === undefined ? null : overrides.maxReferralsPerUser,
        validFrom: new Date(Date.now() - DAY),
        validTo: new Date(Date.now() + DAY),
        isActive: overrides.isActive ?? true,
      },
    });
    return row.id;
  }

  async function makeCode(userId: string, programId: string, maxUses: number | null = null) {
    return db().client.referralCode.create({
      data: {
        userId,
        programId,
        code: `RF${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        maxUses,
      },
    });
  }

  async function completedRideFor(customerId: string): Promise<string> {
    const requestId = await makeRideRequest(customerId, vehicleTypeId);
    await db().client.rideRequest.update({
      where: { id: requestId },
      data: { status: 'MATCHED' },
    });
    return makeRide({
      requestId,
      customerId,
      driverId,
      vehicleId,
      vehicleTypeId,
      status: 'COMPLETED',
    });
  }

  describe('qualification is idempotent (FR-022)', () => {
    it('counts a redelivered ride.completed exactly once', async () => {
      const programId = await makeProgram({ qualifyingThreshold: 3 });
      const referrer = await makeUser('+919876660010');
      const code = await makeCode(referrer, programId);
      const referee = await makeUser('+919876660011');
      await applyService.applyAtSignup({
        code: code.code,
        refereeUserId: referee,
        audience: 'RIDER',
      });

      const rideId = await completedRideFor(referee);

      // `ride.completed` is delivered at least once (constitution 7.3). Three
      // deliveries of ONE ride must not satisfy a threshold of three.
      await runtime.handleRideCompleted(rideId);
      await runtime.handleRideCompleted(rideId);
      await runtime.handleRideCompleted(rideId);

      const referral = await db().client.referral.findFirstOrThrow({
        where: { programId, refereeId: referee },
      });
      assert.equal(referral.qualifyingRides, 1, 'one ride is one ride, however often it arrives');
      assert.equal(referral.status, 'SIGNED_UP', 'and the threshold must not be reached');
      assert.equal(
        await db().client.referralReward.count({ where: { referralId: referral.id } }),
        0,
        'no reward may be paid for a replayed ride',
      );
    });

    it('counts distinct rides and pays once the threshold is genuinely met', async () => {
      const programId = await makeProgram({ qualifyingThreshold: 2 });
      const referrer = await makeUser('+919876660020');
      const code = await makeCode(referrer, programId);
      const referee = await makeUser('+919876660021');
      await applyService.applyAtSignup({
        code: code.code,
        refereeUserId: referee,
        audience: 'RIDER',
      });

      await runtime.handleRideCompleted(await completedRideFor(referee));
      await runtime.handleRideCompleted(await completedRideFor(referee));

      const referral = await db().client.referral.findFirstOrThrow({
        where: { programId, refereeId: referee },
      });
      assert.equal(referral.qualifyingRides, 2);
      assert.equal(referral.status, 'REWARDED');
      assert.equal(
        await db().client.referralReward.count({ where: { referralId: referral.id } }),
        2,
        'referrer and referee are each paid once',
      );
    });
  });

  describe('a reward is paid or the referral is not marked paid (FR-023)', () => {
    it('rolls back rather than marking REWARDED with an uncredited reward', async () => {
      // A DRIVER-wallet program whose referrer never became a driver: the exact
      // shape that used to `return` from grantReward, leave the reward PENDING
      // and set the referral REWARDED anyway.
      const programId = await makeProgram({
        audience: 'RIDER',
        rewardWallet: 'DRIVER',
        qualifyingThreshold: 1,
      });
      const referrer = await makeUser('+919876660030');
      const code = await makeCode(referrer, programId);
      const referee = await makeUser('+919876660031');
      await applyService.applyAtSignup({
        code: code.code,
        refereeUserId: referee,
        audience: 'RIDER',
      });

      await runtime.handleRideCompleted(await completedRideFor(referee));

      const referral = await db().client.referral.findFirstOrThrow({
        where: { programId, refereeId: referee },
      });
      assert.notEqual(referral.status, 'REWARDED', 'an unpaid referral must not read as paid');
      assert.equal(
        await db().client.referralReward.count({
          where: { referralId: referral.id, status: 'CREDITED' },
        }),
        0,
      );
      // And nothing is left dangling: the transaction rolled back, so the
      // half-written reward row does not exist either.
      assert.equal(
        await db().client.referralReward.count({ where: { referralId: referral.id } }),
        0,
        'the reward row must roll back with the transaction that made it',
      );
    });

    it('the sweep reports a reward left PENDING (FR-024)', async () => {
      const programId = await makeProgram();
      const referrer = await makeUser('+919876660040');
      const referee = await makeUser('+919876660041');
      const referral = await db().client.referral.create({
        data: { programId, referrerId: referrer, refereeId: referee, status: 'QUALIFIED' },
      });
      await db().client.referralReward.create({
        data: {
          referralId: referral.id,
          beneficiary: 'REFERRER',
          userId: referrer,
          amount: 100,
          status: 'PENDING',
          createdAt: new Date(Date.now() - 5 * 60 * 60 * 1000),
        },
      });

      const report = await sweepJob.run();
      assert.equal(report.pending, 1, 'a reward that never credited must be visible');
      assert.ok((report.oldestAgeMinutes ?? 0) >= 240);
    });
  });

  describe('who may apply a code (FR-025, BD-6)', () => {
    it('refuses a rider who has already completed a ride', async () => {
      const programId = await makeProgram();
      const referrer = await makeUser('+919876660050');
      const code = await makeCode(referrer, programId);
      const veteran = await makeUser('+919876660051');
      await completedRideFor(veteran);

      await assert.rejects(
        () =>
          applyService.applyAtSignup({
            code: code.code,
            refereeUserId: veteran,
            audience: 'RIDER',
          }),
        /after your first ride/i,
        'applyAtSignup is reachable long after signup and must check',
      );
    });

    it('refuses an account older than the qualification window', async () => {
      const programId = await makeProgram();
      const referrer = await makeUser('+919876660060');
      const code = await makeCode(referrer, programId);
      const dormant = await makeUser('+919876660061', new Date(Date.now() - 400 * DAY));

      await assert.rejects(
        () =>
          applyService.applyAtSignup({
            code: code.code,
            refereeUserId: dormant,
            audience: 'RIDER',
          }),
        /within \d+ days/i,
        'a dormant year-old account is not a new user',
      );
    });

    it('accepts a genuinely new rider', async () => {
      const programId = await makeProgram();
      const referrer = await makeUser('+919876660070');
      const code = await makeCode(referrer, programId);
      const fresh = await makeUser('+919876660071');

      const result = await applyService.applyAtSignup({
        code: code.code,
        refereeUserId: fresh,
        audience: 'RIDER',
      });
      assert.equal(result.referrerId, referrer);
    });
  });

  it('R4: never exceeds the per-code usage cap under concurrency (FR-027, FR-045)', async () => {
    // The cap now comes from the program, so an admin change reaches codes that
    // were already issued (FR-045).
    const programId = await makeProgram({ maxReferralsPerUser: 2 });
    const referrer = await makeUser('+919876660080');
    const code = await makeCode(referrer, programId, null);

    const referees: string[] = [];
    for (let i = 0; i < 5; i++) referees.push(await makeUser(`+91987666009${i}`));

    const results = await Promise.allSettled(
      referees.map((refereeUserId) =>
        applyService.applyAtSignup({ code: code.code, refereeUserId, audience: 'RIDER' }),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;

    assert.equal(ok, 2, 'the cap is two, whatever the concurrency');
    const after = await db().client.referralCode.findUniqueOrThrow({ where: { id: code.id } });
    assert.equal(after.usesCount, 2, 'and usesCount must never pass it');
    assert.equal(await db().client.referral.count({ where: { programId } }), 2);
  });

  it('flags a referral between two accounts sharing a device (FR-028)', async () => {
    const programId = await makeProgram({ qualifyingEvent: 'SIGNUP' });
    const referrer = await makeUser('+919876660100');
    const code = await makeCode(referrer, programId);
    const referee = await makeUser('+919876660101');

    // Same client-reported device id on both accounts — the naive self-referral.
    for (const userId of [referrer, referee]) {
      await db().client.userDevice.create({
        data: { userId, deviceId: 'device-shared-1', platform: 'ANDROID' },
      });
    }

    const result = await applyService.applyAtSignup({
      code: code.code,
      refereeUserId: referee,
      audience: 'RIDER',
    });

    const flags = await db().client.referralFraudFlag.findMany({
      where: { referralId: result.referralId },
    });
    assert.equal(flags.length, 1, 'ReferralFraudFlag finally has a writer');
    assert.equal(flags[0]?.reason, 'SHARED_DEVICE');

    // A SIGNUP-qualifying program would normally pay immediately. Flagged, it
    // must not.
    assert.equal(
      await db().client.referralReward.count({ where: { referralId: result.referralId } }),
      0,
      'a flagged referral must not pay until someone reviews it',
    );
  });

  it('keeps at most one active program per audience (FR-026, BD-7)', async () => {
    const first = await makeProgram({ audience: 'RIDER', code: 'RIDER_ONE' });
    const second = await makeProgram({ audience: 'RIDER', code: 'RIDER_TWO' });
    const driverProgram = await makeProgram({ audience: 'DRIVER', code: 'DRIVER_ONE' });

    // Created directly here, so enforce it the way the admin service does.
    const programs = container.resolve<{
      activate(id: string): Promise<unknown>;
    }>('adminReferralProgramService');
    await programs.activate(second);

    const active = await db().client.referralProgram.findMany({
      where: { audience: 'RIDER', isActive: true },
      select: { id: true },
    });
    assert.deepEqual(
      active.map((p) => p.id),
      [second],
      'activating one rider program must retire the other',
    );

    const driverStillActive = await db().client.referralProgram.findUniqueOrThrow({
      where: { id: driverProgram },
    });
    assert.equal(driverStillActive.isActive, true, 'the other audience is untouched');
    assert.ok(first);
  });
});

import type { DatabaseService } from '@core/database';
import { TransactionManager, type TransactionClient } from '@core/database/TransactionManager.js';
import { referralConfig } from '@config';
import type { ReferralRuntimeService } from './referral-runtime.service.js';
import { ReferralMetrics } from './referral.metrics.js';
import {
  RefereeNotEligibleError,
  ReferralAlreadyAppliedError,
  ReferralCodeAudienceMismatchError,
  ReferralCodeInvalidError,
  ReferralSelfReferralError,
} from './referral.errors.js';

type DbClient = DatabaseService['client'] | TransactionClient;
type ReferralAudience = 'RIDER' | 'DRIVER';

export interface ApplyReferralInput {
  code: string;
  refereeUserId: string;
  audience: ReferralAudience;
}

export interface ApplyReferralResult {
  referralId: string;
  referralCodeId: string;
  programId: string;
  referrerId: string;
  status: string;
}

export class ReferralApplyService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly referralRuntimeService: ReferralRuntimeService,
    private readonly transactionManager: TransactionManager,
    private readonly referralMetrics: ReferralMetrics,
  ) {}

  /// FR-027. One transaction for the whole thing.
  ///
  /// Called without a `tx` — which is what the controller does — the referral
  /// create, the code's usage increment and `onReferralApplied` (which opened a
  /// transaction of its own) were three independent units. A crash between them
  /// left a referral with no usage recorded, or a usage recorded against a
  /// referral that was never rewarded.
  async applyAtSignup(input: ApplyReferralInput, tx?: DbClient): Promise<ApplyReferralResult> {
    if (tx) return this.applyWithin(input, tx);
    return this.transactionManager.execute((innerTx) => this.applyWithin(input, innerTx));
  }

  /// BD-6 option C: both conditions, whichever binds first.
  ///
  /// The ride check alone lets a year-old dormant account claim a referee
  /// reward; the age check alone lets a brand-new account that has already
  /// ridden claim one. Neither is sufficient by itself.
  private async assertRefereeIsNew(client: DbClient, refereeUserId: string): Promise<void> {
    const completed = await client.ride.count({
      where: { customerId: refereeUserId, status: 'COMPLETED' },
    });
    if (completed > 0) {
      throw new RefereeNotEligibleError('A referral code cannot be applied after your first ride');
    }

    const user = await client.user.findUnique({
      where: { id: refereeUserId },
      select: { createdAt: true },
    });
    if (!user) throw new RefereeNotEligibleError('User not found');

    const ageDays = (Date.now() - user.createdAt.getTime()) / 86400000;
    if (ageDays > referralConfig.refereeMaxAccountAgeDays) {
      throw new RefereeNotEligibleError(
        `A referral code must be applied within ${referralConfig.refereeMaxAccountAgeDays} days of signing up`,
      );
    }
  }

  /// The cheapest signal that two accounts are one person: they have reported
  /// the same client device id. `UserDevice` already tracks it — along with
  /// `isRooted` / `isJailbroken` — and none of it was consulted anywhere.
  ///
  /// ponytail: device-id reuse only. A determined actor changes devices, and
  /// `fingerprint`, payout account and IP clustering are the next signals to add
  /// if abuse shows up. Recorded as a ceiling in plan.md rather than pretended
  /// to be complete.
  private async sharedDeviceBetween(
    client: DbClient,
    referrerId: string,
    refereeId: string,
  ): Promise<string | null> {
    const referrerDevices = await client.userDevice.findMany({
      where: { userId: referrerId, deviceId: { not: null } },
      select: { deviceId: true },
    });
    const deviceIds = referrerDevices
      .map((row) => row.deviceId)
      .filter((id): id is string => id !== null);
    if (deviceIds.length === 0) return null;

    const shared = await client.userDevice.findFirst({
      where: { userId: refereeId, deviceId: { in: deviceIds } },
      select: { deviceId: true },
    });
    return shared?.deviceId ?? null;
  }

  private async applyWithin(
    input: ApplyReferralInput,
    client: DbClient,
  ): Promise<ApplyReferralResult> {
    const normalized = input.code.trim().toUpperCase();
    if (!normalized) throw new ReferralCodeInvalidError('Referral code is required');

    // FR-044. Exact match on the normalised value so the unique index on
    // upper(code) answers this, rather than the ILIKE that `mode: 'insensitive'`
    // compiles to and which no index can serve.
    const referralCode = await client.referralCode.findFirst({
      where: { code: normalized },
      include: { program: true },
    });
    if (!referralCode?.isActive) throw new ReferralCodeInvalidError();

    const program = referralCode.program;
    const now = new Date();
    if (!program.isActive || program.validFrom > now || program.validTo < now) {
      throw new ReferralCodeInvalidError('Referral program is not currently active');
    }
    if (program.audience !== input.audience) {
      throw new ReferralCodeAudienceMismatchError();
    }
    if (referralCode.userId === input.refereeUserId) {
      throw new ReferralSelfReferralError();
    }

    // FR-045. The cap is the program's, read now — not the copy snapshotted onto
    // the code when it was first issued. `getMe` creates a code on first view, so
    // in practice every active user had one, and an admin raising or lowering
    // `maxReferralsPerUser` afterwards changed nothing for any of them.
    const cap = program.maxReferralsPerUser;

    // FR-025 / BD-6. `applyAtSignup` is reachable from an ordinary authenticated
    // route long after signup, and checked nothing about the referee at all — so
    // a rider with a thousand completed rides could claim a referee reward today.
    await this.assertRefereeIsNew(client, input.refereeUserId);

    if (input.audience === 'DRIVER') {
      const referrerDriver = await client.driver.findUnique({
        where: { userId: referralCode.userId },
      });
      if (!referrerDriver || referrerDriver.verificationStatus !== 'VERIFIED') {
        throw new ReferralCodeInvalidError('Referrer must be a verified driver');
      }
    }

    const existing = await client.referral.findUnique({
      where: {
        programId_refereeId: {
          programId: program.id,
          refereeId: input.refereeUserId,
        },
      },
    });
    if (existing) throw new ReferralAlreadyAppliedError();

    // BD-8 / FR-046. Read from the field named for what it does. `rewardExpiryDays`
    // is the old name for the same number and is still written below, until the
    // contract migration drops it.
    const windowDays = program.qualificationWindowDays ?? program.rewardExpiryDays;
    const expiresAt = windowDays != null ? new Date(now.getTime() + windowDays * 86400000) : null;

    const referral = await client.referral.create({
      data: {
        programId: program.id,
        referrerId: referralCode.userId,
        refereeId: input.refereeUserId,
        referralCodeId: referralCode.id,
        status: 'SIGNED_UP',
        qualifyingRides: 0,
        signedUpAt: now,
        expiresAt,
      },
    });

    // FR-027. Conditional claim, not a read followed by an increment. The cap was
    // read at the top of this method and incremented here; concurrent signups on
    // one code all passed the check and all incremented, so the cap did not hold
    // under exactly the conditions it exists for. The affected-row count decides
    // (constitution 5.2).
    if (cap != null) {
      const claimed = await client.referralCode.updateMany({
        where: { id: referralCode.id, usesCount: { lt: cap } },
        data: { usesCount: { increment: 1 } },
      });
      if (claimed.count !== 1) {
        throw new ReferralCodeInvalidError('Referral code has reached its usage limit');
      }
    } else {
      await client.referralCode.update({
        where: { id: referralCode.id },
        data: { usesCount: { increment: 1 } },
      });
    }

    // FR-028. `ReferralFraudFlag` and its enum, reviewer relation and index have
    // existed since the schema landed with zero writers anywhere in src/, so the
    // entire anti-abuse surface was the self-referral id comparison above. The
    // driver program pays into the settlement wallet on approval alone, which
    // makes "refer accounts you control" the obvious attack.
    const sharedDevice = await this.sharedDeviceBetween(
      client,
      referralCode.userId,
      input.refereeUserId,
    );
    if (sharedDevice) {
      await client.referralFraudFlag.create({
        data: {
          referralId: referral.id,
          reason: 'SHARED_DEVICE',
          status: 'SUSPECTED',
          details: { deviceId: sharedDevice },
        },
      });
      this.referralMetrics.fraudFlagged({ reason: 'SHARED_DEVICE', audience: input.audience });
    }

    // A flagged referral is recorded and left SIGNED_UP: it does not qualify and
    // does not pay until someone resolves the flag. Deliberately not refused —
    // a shared device is evidence, not proof, and a family sharing a phone is a
    // real customer.
    if (!sharedDevice && program.qualifyingEvent === 'SIGNUP') {
      await this.referralRuntimeService.onReferralApplied(referral.id, client);
    }

    const updated = await client.referral.findUniqueOrThrow({ where: { id: referral.id } });

    return {
      referralId: referral.id,
      referralCodeId: referralCode.id,
      programId: program.id,
      referrerId: referralCode.userId,
      status: updated.status,
    };
  }
}

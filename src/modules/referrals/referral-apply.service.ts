import type { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager.js';
import type { ReferralRuntimeService } from './referral-runtime.service.js';
import {
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
  ) {}

  async applyAtSignup(input: ApplyReferralInput, tx?: DbClient): Promise<ApplyReferralResult> {
    const client = tx ?? this.databaseService.client;
    const normalized = input.code.trim().toUpperCase();
    if (!normalized) throw new ReferralCodeInvalidError('Referral code is required');

    const referralCode = await client.referralCode.findFirst({
      where: { code: { equals: normalized, mode: 'insensitive' } },
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
    if (referralCode.maxUses != null && referralCode.usesCount >= referralCode.maxUses) {
      throw new ReferralCodeInvalidError('Referral code has reached its usage limit');
    }

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

    const expiresAt =
      program.rewardExpiryDays != null
        ? new Date(now.getTime() + program.rewardExpiryDays * 86400000)
        : null;

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

    await client.referralCode.update({
      where: { id: referralCode.id },
      data: { usesCount: { increment: 1 } },
    });

    if (program.qualifyingEvent === 'SIGNUP') {
      await this.referralRuntimeService.onReferralApplied(referral.id, tx);
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

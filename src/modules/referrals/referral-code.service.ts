import type { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager.js';
import { generateReferralCode } from './code.util.js';
import { ReferralProgramNotActiveError } from './referral.errors.js';

type DbClient = DatabaseService['client'] | TransactionClient;
type ReferralAudience = 'RIDER' | 'DRIVER';

export interface ReferralMeDto {
  audience: ReferralAudience;
  program: {
    id: string;
    code: string;
    name: string | null;
    referrerReward: number;
    refereeReward: number;
    qualifyingEvent: string;
    qualifyingThreshold: number;
  } | null;
  code: string | null;
  codeId: string | null;
  usesCount: number;
  maxUses: number | null;
  shareMessage: string | null;
  stats: {
    totalInvites: number;
    rewardedInvites: number;
    pendingInvites: number;
    nextMilestone: {
      name: string;
      requiredReferrals: number;
      bonusAmount: number;
      remaining: number;
    } | null;
  };
  appliedReferral: {
    status: string;
    programCode: string;
    referrerPhone: string | null;
  } | null;
}

export class ReferralCodeService {
  constructor(private readonly databaseService: DatabaseService) {}

  private async resolveActiveProgram(audience: ReferralAudience, client: DbClient) {
    const now = new Date();
    return client.referralProgram.findFirst({
      where: {
        audience,
        isActive: true,
        validFrom: { lte: now },
        validTo: { gte: now },
      },
      orderBy: { createdAt: 'desc' },
      include: { milestones: { where: { isActive: true }, orderBy: { requiredReferrals: 'asc' } } },
    });
  }

  async getOrCreateCode(userId: string, audience: ReferralAudience, tx?: DbClient) {
    const client = tx ?? this.databaseService.client;
    const program = await this.resolveActiveProgram(audience, client);
    if (!program) throw new ReferralProgramNotActiveError();

    const existing = await client.referralCode.findUnique({
      where: { userId_programId: { userId, programId: program.id } },
    });
    if (existing) return { program, code: existing };

    const profile = await client.userProfile.findUnique({ where: { userId } });
    const seed = profile?.firstName ?? (audience === 'DRIVER' ? 'DRV' : 'RID');
    let codeStr = generateReferralCode(seed, audience === 'DRIVER' ? 'DR' : 'RF');
    for (let attempt = 0; attempt < 5; attempt++) {
      const clash = await client.referralCode.findUnique({ where: { code: codeStr } });
      if (!clash) break;
      codeStr = generateReferralCode(seed, audience === 'DRIVER' ? 'DR' : 'RF');
    }

    const created = await client.referralCode.create({
      data: {
        userId,
        programId: program.id,
        code: codeStr,
        maxUses: program.maxReferralsPerUser,
        isActive: true,
      },
    });

    if (audience === 'RIDER') {
      await client.userProfile.updateMany({
        where: { userId, referralCode: null },
        data: { referralCode: codeStr },
      });
    }

    return { program, code: created };
  }

  async getMe(userId: string, audience: ReferralAudience): Promise<ReferralMeDto> {
    const client = this.databaseService.client;
    const program = await this.resolveActiveProgram(audience, client);

    const empty: ReferralMeDto = {
      audience,
      program: null,
      code: null,
      codeId: null,
      usesCount: 0,
      maxUses: null,
      shareMessage: null,
      stats: {
        totalInvites: 0,
        rewardedInvites: 0,
        pendingInvites: 0,
        nextMilestone: null,
      },
      appliedReferral: null,
    };
    if (!program) return empty;

    let codeRow = await client.referralCode.findUnique({
      where: { userId_programId: { userId, programId: program.id } },
    });
    if (!codeRow) {
      try {
        const created = await this.getOrCreateCode(userId, audience);
        codeRow = created.code;
      } catch {
        return empty;
      }
    }

    const referralsMade = await client.referral.findMany({
      where: { referrerId: userId, programId: program.id },
      select: { status: true },
    });
    // Customer wallet retirement: a rider referral is non-monetary and ends at
    // QUALIFIED (see `ReferralRuntimeService`), so for riders QUALIFIED is
    // done, not pending, and no amount or milestone bonus is advertised —
    // whatever a legacy program row still carries. `rewardedInvites` still
    // counts historical REWARDED referrals.
    const monetary = audience === 'DRIVER';
    const rewardedInvites = referralsMade.filter((r) => r.status === 'REWARDED').length;
    const pendingStatuses = monetary
      ? ['PENDING', 'SIGNED_UP', 'QUALIFIED']
      : ['PENDING', 'SIGNED_UP'];
    const pendingInvites = referralsMade.filter((r) => pendingStatuses.includes(r.status)).length;

    const achievements = await client.referralMilestoneAchievement.findMany({
      where: { userId, milestone: { programId: program.id } },
      select: { milestoneId: true },
    });
    const achievedIds = new Set(achievements.map((a) => a.milestoneId));
    const nextMilestone = monetary
      ? (program.milestones.find((m) => !achievedIds.has(m.id)) ?? null)
      : null;

    const applied = await client.referral.findFirst({
      where: { refereeId: userId, programId: program.id },
      include: { referrer: { select: { phoneNumber: true } }, program: { select: { code: true } } },
    });

    const referrerReward = monetary ? Number(program.referrerReward.toString()) : 0;
    const refereeReward = monetary ? Number(program.refereeReward.toString()) : 0;

    return {
      audience,
      program: {
        id: program.id,
        code: program.code,
        name: program.name,
        referrerReward,
        refereeReward,
        qualifyingEvent: program.qualifyingEvent,
        qualifyingThreshold: program.qualifyingThreshold,
      },
      code: codeRow.code,
      codeId: codeRow.id,
      usesCount: codeRow.usesCount,
      maxUses: codeRow.maxUses,
      shareMessage:
        audience === 'DRIVER'
          ? `Join Zaroorat as a driver with my code ${codeRow.code} and earn ₹${refereeReward} after approval.`
          : `Join Zaroorat with my code ${codeRow.code} when you sign up.`,
      stats: {
        totalInvites: referralsMade.length,
        rewardedInvites,
        pendingInvites,
        nextMilestone: nextMilestone
          ? {
              name: nextMilestone.name,
              requiredReferrals: nextMilestone.requiredReferrals,
              bonusAmount: Number(nextMilestone.bonusAmount.toString()),
              remaining: Math.max(0, nextMilestone.requiredReferrals - rewardedInvites),
            }
          : null,
      },
      appliedReferral: applied
        ? {
            status: applied.status,
            programCode: applied.program.code,
            referrerPhone: applied.referrer.phoneNumber,
          }
        : null,
    };
  }
}

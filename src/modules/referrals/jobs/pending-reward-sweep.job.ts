import type { DatabaseService } from '@core/database';
import { referralConfig } from '@config';
import { logger } from '@shared/logger/index.js';
import { ReferralMetrics } from '../referral.metrics.js';

export interface PendingRewardSweepReport {
  pending: number;
  oldestAgeMinutes: number | null;
}

/// FR-024. Surfaces referral rewards that were created but never credited.
///
/// `grantReward` writes the `ReferralReward` row PENDING and credits the wallet
/// immediately after, in the same transaction — so a row still PENDING once that
/// transaction has long committed is a reward that was lost. Before FR-023 that
/// happened on a plain `return` when the beneficiary had no driver wallet: the
/// referral was marked REWARDED, the status guard short-circuited every retry,
/// and nothing anywhere looked at the orphaned row.
///
/// FR-023 closed the path that created them. This job exists because "we fixed
/// the one we found" is not a guarantee for a money path — it reports the
/// condition rather than assuming it can no longer occur.
///
/// ponytail: reports, does not re-credit. Automatically re-issuing money on a
/// schedule is a bigger decision than this feature is allowed to make; the
/// counter is what an operator needs to know a reward went missing. Upgrade to
/// automated retry only with an explicit business decision behind it.
export class ReferralPendingRewardSweepJob {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly referralMetrics: ReferralMetrics,
  ) {}

  async run(now: Date = new Date()): Promise<PendingRewardSweepReport> {
    const cutoff = new Date(now.getTime() - referralConfig.pendingRewardSweepMinutes * 60_000);

    const stale = await this.databaseService.client.referralReward.findMany({
      where: { status: 'PENDING', createdAt: { lt: cutoff } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, referralId: true, userId: true, beneficiary: true, createdAt: true },
      take: 500,
    });

    const oldestAgeMinutes =
      stale.length > 0 && stale[0]
        ? Math.round((now.getTime() - stale[0].createdAt.getTime()) / 60_000)
        : null;

    if (stale.length > 0) {
      this.referralMetrics.rewardsPendingSwept(stale.length);
      logger.error(
        {
          pending: stale.length,
          oldestAgeMinutes,
          rewardIds: stale.slice(0, 20).map((row) => row.id),
        },
        '[referral] rewards created but never credited',
      );
    }

    return { pending: stale.length, oldestAgeMinutes };
  }
}

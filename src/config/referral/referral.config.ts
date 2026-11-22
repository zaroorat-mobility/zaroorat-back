import { numericEnv } from '../env/numeric.js';

export interface ReferralConfig {
  /// BD-6. A referral code may only be applied by a genuinely new account.
  /// "New" is both conditions, whichever binds first: no completed ride, AND an
  /// account younger than this. Either alone leaves a hole — the ride check
  /// alone lets a year-old dormant account claim, the age check alone lets a
  /// brand-new account that has already ridden claim.
  refereeMaxAccountAgeDays: number;
  /// FR-024. How long a `ReferralReward` may sit PENDING before the sweep
  /// reports it. Rewards are credited in the same transaction that creates them,
  /// so anything still PENDING past this window is a reward that was lost.
  pendingRewardSweepMinutes: number;
}

export const referralConfig: ReferralConfig = Object.freeze({
  refereeMaxAccountAgeDays: numericEnv('REFERRAL_REFEREE_MAX_ACCOUNT_AGE_DAYS', 30, {
    min: 1,
    max: 365,
  }),
  pendingRewardSweepMinutes: numericEnv('REFERRAL_PENDING_REWARD_SWEEP_MIN', 60, {
    min: 1,
    max: 1440,
  }),
});

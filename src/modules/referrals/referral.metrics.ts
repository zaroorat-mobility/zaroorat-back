import { logger } from '@shared/logger/index.js';
import { incrementCounter } from '@core/metrics';

export type ReferralMetricFields = Record<string, string | number | boolean>;

/// Constitution 17.1: every money-affecting operation emits a domain metric.
/// Referral rewards move real balance — into the customer wallet, or into the
/// driver settlement wallet — and had no metrics class at all, so the failure
/// modes below were visible only as log lines nobody was alerting on.
export class ReferralMetrics {
  rewardCredited(fields?: ReferralMetricFields): void {
    this.emit('reward_credited_total', fields);
  }

  /// FR-023. The beneficiary has no wallet of the kind the program pays into.
  /// The transaction now rolls back rather than marking the referral REWARDED
  /// with an uncredited row behind it, so this counter is the signal that a
  /// program is misconfigured — a DRIVER-wallet program whose referrer never
  /// became a driver, most likely.
  rewardWalletMissing(fields?: ReferralMetricFields): void {
    this.emit('reward_wallet_missing_total', fields);
  }

  /// The credit was issued but no wallet transaction could be found to link it
  /// to. Should be zero; a non-zero value means the reward audit trail is
  /// incomplete even though the money moved.
  rewardCreditUnverified(fields?: ReferralMetricFields): void {
    this.emit('reward_credit_unverified_total', fields);
  }

  /// FR-024. Rewards still PENDING after the sweep window — created but never
  /// credited. The condition that used to be permanent and invisible.
  rewardsPendingSwept(count: number, fields?: ReferralMetricFields): void {
    this.emit('rewards_pending_swept_total', fields, count);
  }

  /// FR-028. A referral matched a fraud signal and its reward was withheld.
  fraudFlagged(fields?: ReferralMetricFields): void {
    this.emit('fraud_flagged_total', fields);
  }

  private emit(metric: string, fields?: ReferralMetricFields, by = 1): void {
    const name = `referral.${metric}`;
    incrementCounter(name, fields, by);
    logger.info({ metric: name, ...fields }, `[metric] ${name}`);
  }
}

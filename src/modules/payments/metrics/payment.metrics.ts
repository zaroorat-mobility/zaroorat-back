import { logger } from '@shared/logger/index.js';
import { incrementCounter } from '@core/metrics';
export type PaymentMetricFields = Record<string, string | number | boolean>;
export class PaymentMetrics {
  success(fields?: PaymentMetricFields): void {
    this.emit('payment_success_total', fields);
  }
  failure(fields?: PaymentMetricFields): void {
    this.emit('payment_failure_total', fields);
  }
  webhookReceived(fields?: PaymentMetricFields): void {
    this.emit('webhook_received_total', fields);
  }
  webhookDuplicate(fields?: PaymentMetricFields): void {
    this.emit('webhook_duplicate_total', fields);
  }
  webhookFailure(fields?: PaymentMetricFields): void {
    this.emit('webhook_failure_total', fields);
  }
  refundProcessed(fields?: PaymentMetricFields): void {
    this.emit('refund_total', fields);
  }
  refundFailure(fields?: PaymentMetricFields): void {
    this.emit('refund_failure_total', fields);
  }
  payoutSuccess(fields?: PaymentMetricFields): void {
    this.emit('payout_success_total', fields);
  }
  payoutFailure(fields?: PaymentMetricFields): void {
    this.emit('payout_failure_total', fields);
  }
  reconciliationMismatch(fields?: PaymentMetricFields): void {
    this.emit('reconciliation_mismatch_total', fields);
  }
  idempotencyReplayed(fields?: PaymentMetricFields): void {
    this.emit('idempotency_replay_total', fields);
  }
  insufficientBalance(fields?: PaymentMetricFields): void {
    this.emit('wallet_insufficient_balance_total', fields);
  }
  /// Ride collection, separate from `success`/`failure`.
  ///
  /// Those two count *payment intents*; these count *ride obligations*, and
  /// conflating them would make a dashboard unable to answer "are rides being
  /// paid for" — the question this whole feature exists to fix.
  ///
  /// Every field here is an id or a method. No amount, no rider, no card
  /// detail: metrics are logged, and a log is not a place for money or PII.
  collectionSucceeded(fields?: PaymentMetricFields): void {
    this.emit('ride_collection_success_total', fields);
  }
  collectionFailed(fields?: PaymentMetricFields): void {
    this.emit('ride_collection_failure_total', fields);
  }
  /// The attempt that exhausts the budget and creates the receivable.
  receivableCreated(fields?: PaymentMetricFields): void {
    this.emit('receivable_created_total', fields);
  }
  receivableWrittenOff(fields?: PaymentMetricFields): void {
    this.emit('receivable_written_off_total', fields);
  }
  /// BD-6 — a cash ride nobody acknowledged in time. Worth watching on its
  /// own: a rising count means drivers are not confirming, which is a product
  /// problem rather than a payment one.
  cashAutoResolved(fields?: PaymentMetricFields): void {
    this.emit('cash_auto_resolved_total', fields);
  }
  private emit(event: string, fields?: PaymentMetricFields): void {
    incrementCounter(`payment_${event}`, fields);
    logger.info({ metric: `payment.${event}`, ...fields }, `[metric] payment.${event}`);
  }
}

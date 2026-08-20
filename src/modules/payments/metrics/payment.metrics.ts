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
  private emit(event: string, fields?: PaymentMetricFields): void {
    incrementCounter(`payment_${event}`, fields);
    logger.info({ metric: `payment.${event}`, ...fields }, `[metric] payment.${event}`);
  }
}

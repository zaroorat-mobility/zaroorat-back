import type { PublishInput } from '@core/events/types.js';
export const PAYMENT_PRODUCER = 'payments';
export const PAYMENT_EVENT_CATALOG = {
  INTENT_CREATED: 'payment.intent.created',
  PAYMENT_SUCCEEDED: 'payment.succeeded',
  PAYMENT_FAILED: 'payment.failed',
  WALLET_CREDITED: 'payment.wallet.credited',
  WALLET_DEBITED: 'payment.wallet.debited',
  WALLET_HOLD_CREATED: 'payment.wallet.hold_created',
  WALLET_HOLD_RELEASED: 'payment.wallet.hold_released',
  REFUND_PROCESSED: 'payment.refund.processed',
  SETTLEMENT_COMPLETED: 'payment.settlement.completed',
  PAYOUT_INITIATED: 'payment.payout.initiated',
  PAYOUT_COMPLETED: 'payment.payout.completed',
  RECONCILIATION_MISMATCH: 'payment.reconciliation.mismatch',
  /// Every successful ride collection, whatever the method. Cash confirmation
  /// is a collection too, which is why there is no separate cash event.
  RIDE_COLLECTED: 'payment.ride.collected',
  /// One per failed attempt. `willRetry: false` marks the attempt that
  /// exhausts the budget — that same transaction posts the CUSTOMER_RECEIVABLE
  /// debit, so this event IS the receivable-establishing signal. A separate
  /// debt event would describe the same transition twice.
  RIDE_COLLECTION_FAILED: 'payment.ride.collection_failed',
  /// BD-1c — the ageing write-off. Published for finance and audit; there is
  /// deliberately no rider notification.
  RECEIVABLE_WRITTEN_OFF: 'payment.receivable.written_off',
} as const;
export function paymentEvent(
  name: (typeof PAYMENT_EVENT_CATALOG)[keyof typeof PAYMENT_EVENT_CATALOG],
  aggregateId: string,
  data: Record<string, unknown>,
): PublishInput {
  return {
    producer: PAYMENT_PRODUCER,
    type: name,
    classification:
      name.includes('succeeded') ||
      name.includes('credited') ||
      name.includes('debited') ||
      name.includes('completed') ||
      name.includes('processed') ||
      name.includes('collected') ||
      name.includes('written_off')
        ? 'audit'
        : 'domain',
    aggregateType: 'payment',
    aggregateId,
    data,
  };
}

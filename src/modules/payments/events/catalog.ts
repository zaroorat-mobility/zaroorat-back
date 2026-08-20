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
      name.includes('processed')
        ? 'audit'
        : 'domain',
    aggregateType: 'payment',
    aggregateId,
    data,
  };
}

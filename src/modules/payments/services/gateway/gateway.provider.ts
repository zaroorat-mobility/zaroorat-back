import { Decimal } from '../../types/index.js';
export interface CreateGatewayIntentInput {
  amount: Decimal;
  currency: string;
  idempotencyKey: string;
  metadata?: Record<string, string>;
}
export interface GatewayIntentResult {
  gatewayIntentId: string;
  clientSecret?: string;
  status: string;
}
/// A refund is addressed by the PROVIDER's payment id -- the value stored in
/// `PaymentTransaction.gatewayTxnId` (`pay_...` for Razorpay, `ch_...`/`pi_...`
/// for Stripe) -- never by our internal transaction UUID, which no provider knows.
///
/// `refundReference` is our `Refund.id`. It is sent to the provider (Stripe
/// Idempotency-Key + metadata, Razorpay receipt + notes) so the SAME refund can
/// be found again after a timeout, and a retry can never create a second one.
export interface CreateGatewayRefundInput {
  providerPaymentId: string;
  amount: Decimal;
  refundReference: string;
}
export interface GatewayRefundResult {
  gatewayRefundId: string;
  status: 'SUCCEEDED' | 'PENDING' | 'FAILED';
}
export interface PaymentGatewayProvider {
  readonly gatewayName: string;
  createIntent(input: CreateGatewayIntentInput): Promise<GatewayIntentResult>;
  confirmIntent(gatewayIntentId: string): Promise<GatewayIntentResult>;
  createRefund(input: CreateGatewayRefundInput): Promise<GatewayRefundResult>;
  /// The refund previously created for `refundReference`, or null if the
  /// provider has none. Used before every create and by reconciliation.
  findRefund(
    providerPaymentId: string,
    refundReference: string,
  ): Promise<GatewayRefundResult | null>;
}

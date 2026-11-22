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
  /// The provider's payment id (`pay_...`) behind `status`, when there is one.
  providerPaymentId?: string;
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
/// contracts/razorpay-provider.md, "normalised shapes". Everything above the
/// adapters reads these, never a provider's raw response.
export type ProviderPaymentStatus = 'created' | 'authorized' | 'captured' | 'failed' | 'refunded';
export interface ProviderPayment {
  id: string;
  orderId: string;
  amountPaise: number;
  /// Upper-case ISO code.
  currency: string;
  status: ProviderPaymentStatus;
  method: string | null;
  createdAt: Date | null;
}
/// Every payment on one order, reduced by the selection rules of contract §2:
/// the first capture is the candidate; further captures go to review.
export interface OrderPayments {
  kind: 'captured' | 'pending' | 'failed' | 'none';
  payment?: ProviderPayment;
  additionalCaptures: ProviderPayment[];
}
export interface PaymentGatewayProvider {
  readonly gatewayName: string;
  createIntent(input: CreateGatewayIntentInput): Promise<GatewayIntentResult>;
  confirmIntent(gatewayIntentId: string): Promise<GatewayIntentResult>;
  /// Provider truth for reconciliation and staff confirm (decisions.md TD-2).
  fetchOrderPayments(orderId: string): Promise<OrderPayments>;
  /// One payment, for the checkout `verify` path.
  fetchPayment(paymentId: string): Promise<ProviderPayment>;
  /// One page of the account's payments created in [from, to], for the
  /// provider sweep (TD-16). Fewer than a full page means the window is done.
  listPayments(from: Date, to: Date, skip: number): Promise<ProviderPayment[]>;
  /// The PUBLIC key the app's checkout opens with (contracts/http-api.md
  /// `checkout.keyId`), or null when this provider has no client checkout.
  /// Never a secret: the secret stays inside the adapter.
  checkoutKeyId(): string | null;
  /// Checkout success-callback signature over OUR stored order id (TD-4).
  /// Constant-time; false when this provider has no client checkout.
  verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean;
  createRefund(input: CreateGatewayRefundInput): Promise<GatewayRefundResult>;
  /// The refund previously created for `refundReference`, or null if the
  /// provider has none. Used before every create and by reconciliation.
  findRefund(
    providerPaymentId: string,
    refundReference: string,
  ): Promise<GatewayRefundResult | null>;
}
/// Contract §2 selection rules, shared by every adapter. `items` are in
/// creation order; anything for another order is discarded first.
export function selectOrderPayments(orderId: string, items: ProviderPayment[]): OrderPayments {
  const own = items.filter((p) => p.orderId === orderId);
  const [first, ...more] = own.filter((p) => p.status === 'captured');
  if (first) return { kind: 'captured', payment: first, additionalCaptures: more };
  const pending = own.find((p) => p.status === 'authorized' || p.status === 'created');
  if (pending) return { kind: 'pending', payment: pending, additionalCaptures: [] };
  const last = own[own.length - 1];
  if (last) return { kind: 'failed', payment: last, additionalCaptures: [] };
  return { kind: 'none', additionalCaptures: [] };
}

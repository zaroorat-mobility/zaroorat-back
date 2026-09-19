export const PAYMENT_INTENT_STATUS = {
  CREATED: 'CREATED',
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const;
export type PaymentIntentStatus =
  (typeof PAYMENT_INTENT_STATUS)[keyof typeof PAYMENT_INTENT_STATUS];
export const REFUND_STATUS = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
} as const;
export type RefundStatus = (typeof REFUND_STATUS)[keyof typeof REFUND_STATUS];
/// The only things a NEW PaymentIntent may fund — and so the only money that
/// ever reaches Razorpay/Stripe. A customer's ride fare is paid to the driver
/// directly (cash, UPI, a phone transfer) and is never a gateway payment.
///
/// `CUSTOMER_WALLET_TOPUP` is deliberately absent: it is still a valid stored
/// `PaymentIntent.purpose` for historical rows, which confirm and refund as
/// before, but no new intent may be created for it.
export const GATEWAY_PAYMENT_PURPOSES = [
  'DRIVER_SUBSCRIPTION_PAYMENT',
  'DRIVER_COMMISSION_RECHARGE',
] as const;
export type GatewayPaymentPurpose = (typeof GATEWAY_PAYMENT_PURPOSES)[number];
export const LEDGER_ACCOUNTS = {
  CUSTOMER_WALLET: 'CUSTOMER_WALLET',
  DRIVER_PAYABLE: 'DRIVER_PAYABLE',
  PLATFORM_COMMISSION: 'PLATFORM_COMMISSION',
  GATEWAY_CLEARING: 'GATEWAY_CLEARING',
  /// Payout Option A — money leaving the platform's OWN bank account by
  /// manual transfer. Distinct from GATEWAY_CLEARING, which means funds in
  /// transit at a payment gateway: a driver payout executed as a bank transfer
  /// never touches a gateway, and booking it there would corrupt gateway
  /// reconciliation.
  BANK_CLEARING: 'BANK_CLEARING',
  /// Phase 1 refunds. A refund reserves the refunded amount first (the
  /// customer-wallet or commission-wallet balance is debited, or subscription
  /// revenue is reversed) against this clearing account, and only clears it to
  /// GATEWAY_CLEARING once the provider confirms. Net effect is exactly the
  /// reversal of the original collection; in between, balances and the ledger
  /// always agree.
  REFUND_IN_TRANSIT: 'REFUND_IN_TRANSIT',
  TAX_PAYABLE: 'TAX_PAYABLE',
  /// BD-1 — a fare whose collection attempts are exhausted becomes an asset
  /// the customer still owes, not a loss. Debited when the receivable is
  /// created; credited when it is either settled or written off.
  CUSTOMER_RECEIVABLE: 'CUSTOMER_RECEIVABLE',
  /// BD-1c — recognised ONLY at write-off, never when the receivable is
  /// created. Booking bad debt early would understate what the platform is
  /// still owed.
  BAD_DEBT_EXPENSE: 'BAD_DEBT_EXPENSE',
  /// 004-driver-subscription-wallet. Liability — credited on a driver's
  /// Commission Wallet recharge, debited on a commission deduction. Mirrors
  /// CUSTOMER_WALLET's existing treatment (decisions.md BD-6/data-model.md §5).
  DRIVER_COMMISSION_WALLET: 'DRIVER_COMMISSION_WALLET',
  /// 004-driver-subscription-wallet. Revenue — credited once, when a driver's
  /// subscription payment is confirmed. Recognised immediately, not per ride.
  SUBSCRIPTION_REVENUE: 'SUBSCRIPTION_REVENUE',
} as const;
export type LedgerAccount = (typeof LEDGER_ACCOUNTS)[keyof typeof LEDGER_ACCOUNTS];
export const LEDGER_DIRECTION = {
  DEBIT: 'DEBIT',
  CREDIT: 'CREDIT',
} as const;
export type LedgerDirection = (typeof LEDGER_DIRECTION)[keyof typeof LEDGER_DIRECTION];

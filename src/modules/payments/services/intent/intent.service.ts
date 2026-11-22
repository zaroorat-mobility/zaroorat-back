import { Decimal } from '../../types/index.js';
import { TransactionManager } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import { EventPublisher } from '@core/events';
import { IntentRepository } from '../../repositories/intent.repository.js';
import { PaymentReviewCaseRepository } from '../../repositories/payment-review-case.repository.js';
import type { GatewayIntentResult, PaymentGatewayProvider } from '../gateway/gateway.provider.js';
import {
  decidePaymentApplication,
  type GateDecision,
  type GateInput,
  type GatePath,
  type GateProvider,
} from './payment-application-rules.js';
import {
  PaymentGatewayDisabledError,
  PaymentGatewayNotConfiguredError,
  PaymentGatewayResolverService,
} from '../gateway/payment-gateway-resolver.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { WalletService } from '../wallet/wallet.service.js';
import { CommissionWalletService } from '../commission-wallet/commission-wallet.service.js';
import { DriverRepository } from '@modules/drivers/repositories/driver.repository.js';
import { FeatureFlagService } from '@modules/admin/system-settings/platform/services/feature-flag.service.js';
import { PAYMENT_FEATURE_FLAG_KEYS } from '@modules/admin/system-settings/platform/constants/payment-feature-flags.constants.js';
import type { DriverCheckoutSettings } from '@modules/admin/system-settings/integrations/constants/integration-settings.constants.js';
import { logger } from '@shared/logger/index.js';
import {
  DuplicateIdempotencyKeyError,
  InvalidStateTransitionError,
  PaymentGatewayUnavailableError,
  PaymentNotFoundError,
  PaymentOrderMismatchError,
  PaymentPurposeNotAllowedError,
  PaymentSignatureInvalidError,
  PaymentsUnavailableError,
} from '../../errors/payment.errors.js';
import {
  GATEWAY_PAYMENT_PURPOSES,
  type GatewayPaymentPurpose,
} from '../../constants/payment.constants.js';
import { paymentEvent, PAYMENT_EVENT_CATALOG } from '../../events/catalog.js';
import { PaymentMetrics } from '../../metrics/payment.metrics.js';
import type { PaymentIntent } from '../../types';
/// Contract: a timeout, 5xx, 429 or 408 from the provider is an unknown
/// outcome, never a failure (INV-8).
function isTransientProviderError(err: unknown): boolean {
  const status = (err as { statusCode?: number }).statusCode;
  return status !== undefined && (status >= 500 || status === 429 || status === 408);
}
/// contracts/http-api.md `checkout`: everything the app's native checkout
/// needs, and nothing secret.
export interface CheckoutPayload {
  provider: string;
  keyId: string;
  orderId: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  /// UD-9 (a): the paying driver's own number, so checkout does not ask for it,
  /// plus the company checkout email from Admin (never the driver's own).
  prefill?: { contact: string; email?: string };
}
/// `GET /payments/driver-wallet/recharge-options?include=checkout`: the active
/// gateway's PUBLIC key id, for the Driver App's payment-method discovery
/// before any order exists. Never a secret. `checkout` is null when the
/// provider has no client checkout (the mock in development) or is not usable,
/// and then `checkoutError` says why when it is a configuration problem.
export interface CheckoutConfigView {
  checkout: {
    provider: string;
    keyId: string;
    /// Admin's method switches; UPI is always on.
    methods: DriverCheckoutSettings['methods'];
  } | null;
  checkoutError: {
    code: 'PAYMENT_GATEWAY_NOT_CONFIGURED' | 'PAYMENT_GATEWAY_DISABLED' | 'PAYMENT_EMAIL_NOT_SET';
  } | null;
}
/// A Razorpay public key id; anything else is treated as not configured.
const RAZORPAY_KEY_ID = /^rzp_(test|live)_[A-Za-z0-9]{6,}$/;
/// contracts/http-api.md `GET /payments/intents/:intentId`.
export interface IntentStatusView {
  intentId: string;
  purpose: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'EXPIRED' | 'IN_REVIEW' | 'REFUNDED';
  amount: number;
  currency: string;
  createdAt: Date;
  effect:
    | { walletBalance: number }
    | {
        subscriptionId: string;
        subscriptionStatus: string;
        startDate: Date | null;
        expiryDate: Date | null;
      }
    | null;
  supportReference: string;
}
export interface CheckoutCallback {
  razorpayPaymentId: string;
  razorpayOrderId: string;
  razorpaySignature: string;
}
const CHECKOUT_MERCHANT_NAME = 'Zaroorat';
/// data-model.md §2. MANUAL_REVIEW leaves only through a Finance resolution
/// (UD-1, T081); SUCCEEDED never goes back.
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  CREATED: ['PENDING', 'PROCESSING', 'CANCELLED'],
  PENDING: ['PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED', 'MANUAL_REVIEW'],
  PROCESSING: ['SUCCEEDED', 'FAILED', 'CANCELLED', 'MANUAL_REVIEW'],
  SUCCEEDED: ['REFUND_PENDING', 'REFUNDED'],
  FAILED: ['SUCCEEDED', 'EXPIRED', 'CANCELLED', 'MANUAL_REVIEW'],
  EXPIRED: ['SUCCEEDED', 'CANCELLED', 'MANUAL_REVIEW'],
  CANCELLED: ['MANUAL_REVIEW'],
  MANUAL_REVIEW: ['SUCCEEDED', 'CANCELLED'],
  REFUND_PENDING: ['REFUNDED'],
  REFUNDED: [],
};
/// Review kinds that write a CAPTURED_REVIEW hold row (INV-2). Not
/// PAYMENT_ID_REUSED (the payment already has its SUCCEEDED row, data-model
/// §3), EXTERNAL_REFUND (already recorded, or never ours), UNKNOWN_ORDER (no
/// intent), nor ORDER_MISMATCH: that payment may be another intent's, and a
/// hold here would block it there.
const HOLD_ROW_KINDS = new Set([
  'AMOUNT_MISMATCH',
  'CURRENCY_MISMATCH',
  'MULTIPLE_CAPTURES',
  'UNMATCHED_CAPTURE',
]);
type GatePayment = Extract<GateProvider, { kind: 'payment' }>;
const toPaise = (amount: Decimal): number => amount.mul(100).toDecimalPlaces(0).toNumber();
const CHECKOUT_FLAG_BY_PURPOSE: Readonly<Record<GatewayPaymentPurpose, string>> = {
  DRIVER_COMMISSION_RECHARGE: PAYMENT_FEATURE_FLAG_KEYS.DRIVER_CHECKOUT,
  DRIVER_SUBSCRIPTION_PAYMENT: PAYMENT_FEATURE_FLAG_KEYS.SUBSCRIPTION_CHECKOUT,
};
export class IntentService {
  constructor(
    private readonly intentRepo: IntentRepository,
    private readonly gatewayResolver: PaymentGatewayResolverService,
    private readonly ledgerService: LedgerService,
    private readonly txManager: TransactionManager,
    private readonly eventPublisher: EventPublisher,
    private readonly paymentMetrics: PaymentMetrics,
    private readonly walletService: WalletService,
    private readonly commissionWalletService: CommissionWalletService,
    private readonly driverRepository: DriverRepository,
    private readonly featureFlagService: FeatureFlagService,
    private readonly paymentReviewCaseRepo: PaymentReviewCaseRepository,
  ) {}
  /// decisions.md TD-12: each purpose has its own kill switch, seeded OFF.
  /// Callers run this before their first write. Confirmation never calls it,
  /// so an intent created while the switch was on can still be confirmed.
  async assertCheckoutOpen(purpose: GatewayPaymentPurpose): Promise<void> {
    if (!(await this.featureFlagService.isEnabled(CHECKOUT_FLAG_BY_PURPOSE[purpose]))) {
      throw new PaymentsUnavailableError();
    }
  }
  validateTransition(fromState: string, toState: string): void {
    const allowed = ALLOWED_TRANSITIONS[fromState] ?? [];
    if (!allowed.includes(toState)) {
      throw new InvalidStateTransitionError(fromState, toState);
    }
  }
  async createIntent(data: {
    userId: string;
    rideId?: string;
    amount: Decimal;
    methodType: string;
    paymentMethodId?: string;
    idempotencyKey: string;
    /// Required, and only a platform charge: a customer's ride fare is paid to
    /// the driver directly and never reaches a gateway.
    purpose: GatewayPaymentPurpose;
  }): Promise<PaymentIntent> {
    // Checked before anything else — before the idempotency lookup and before
    // any provider call — so nothing outside the invariant is ever created or
    // sent to a gateway, whatever a caller passes at runtime.
    if (!(GATEWAY_PAYMENT_PURPOSES as readonly string[]).includes(data.purpose)) {
      throw new PaymentPurposeNotAllowedError(String(data.purpose));
    }
    await this.assertCheckoutOpen(data.purpose);
    const existing = await this.intentRepo.findByIdempotencyKey(data.idempotencyKey);
    if (existing) {
      // Callers store keys scoped by driver (`recharge:{driverId}:…`,
      // `subscription:{driverId}:…`), so another user's intent should be
      // unreachable. If one is found anyway, answer without revealing it.
      if (existing.userId !== data.userId) {
        logger.warn(
          { userId: data.userId, intentId: existing.id },
          "[payments] idempotency key matched another user's payment intent",
        );
        throw new DuplicateIdempotencyKeyError();
      }
      // A replay must be the same payment. Without this, a key that collides
      // with a historical CUSTOMER_WALLET_TOPUP intent would hand that intent
      // back to be paid, re-opening the gateway path the check above closes.
      if (existing.purpose !== data.purpose) throw new DuplicateIdempotencyKeyError();
      return existing;
    }
    // The active provider is resolved ONCE, here, at creation — the result is
    // what gets written to PaymentIntent.gateway below and is authoritative
    // for this intent's entire lifetime, regardless of any later change to
    // which provider is active. No purpose-based routing and no caller-chosen
    // provider: whichever gateway Admin has made active handles every new
    // intent, automatically.
    const gateway = await this.gatewayResolver.getActiveGateway();
    // Contract §1 notes: purpose and driver id only, no user id, name, phone
    // or email. Never read back to decide whom to credit.
    const driver = await this.driverRepository.findByUserId(data.userId);
    let gatewayRes: GatewayIntentResult;
    try {
      gatewayRes = await gateway.createIntent({
        amount: data.amount,
        currency: 'INR',
        idempotencyKey: data.idempotencyKey,
        metadata: { purpose: data.purpose, ...(driver ? { driver_ref: driver.id } : {}) },
      });
    } catch (err) {
      // Contract: provider unreachable → 503 and nothing written. A retry with
      // the same key is safe: the idempotency claim is released on error, and
      // TD-3 accepts that a timed-out order may exist unpaid at the provider.
      if (isTransientProviderError(err)) throw new PaymentGatewayUnavailableError();
      throw err;
    }
    return this.txManager.execute(async (tx) => {
      const intent = await this.intentRepo.create(
        {
          userId: data.userId,
          rideId: data.rideId ?? null,
          amount: data.amount,
          methodType: data.methodType,
          paymentMethodId: data.paymentMethodId ?? null,
          idempotencyKey: data.idempotencyKey,
          gateway: gateway.gatewayName,
          gatewayIntentId: gatewayRes.gatewayIntentId,
          purpose: data.purpose,
        },
        tx,
      );
      await this.eventPublisher.publish(
        paymentEvent(PAYMENT_EVENT_CATALOG.INTENT_CREATED, data.userId, {
          intentId: intent.id,
          amount: data.amount.toNumber(),
          gatewayIntentId: gatewayRes.gatewayIntentId,
        }),
        tx,
      );
      return intent;
    });
  }
  async findById(intentId: string): Promise<PaymentIntent | null> {
    return this.intentRepo.findById(intentId);
  }
  async findByGatewayReference(
    reference: string,
    tx?: TransactionClient,
  ): Promise<PaymentIntent | null> {
    // Decision R1 (2026-10-21): only the intent that owns the provider's order
    // id. The former fallback to our own intent id let a payload carrying an
    // intent UUID as its order claim that intent.
    return this.intentRepo.findByGatewayIntentId(reference, tx);
  }
  /// Reconciliation and staff confirm: provider truth for the intent's own
  /// order (TD-2) through the gate. Every further capture on the order goes
  /// through the gate as well, and so to review (A7).
  async confirmIntent(intentId: string, path: GatePath = 'RECONCILIATION'): Promise<PaymentIntent> {
    const intent = await this.intentRepo.findById(intentId);
    if (!intent) throw new PaymentNotFoundError(intentId);
    if (intent.status === 'SUCCEEDED') return intent;
    // Resolved by the intent's OWN stored provider — never by current
    // routing, which may have changed since this intent was created.
    const gateway = await this.gatewayResolver.forProviderName(intent.gateway ?? 'mock');
    const records = await this.fetchOrderPayments(gateway, intent.gatewayIntentId ?? intent.id);
    if (records.length === 0) return intent;
    return this.txManager.execute(async (tx) => {
      let updated: PaymentIntent = intent;
      for (const provider of records) {
        updated = await this.applyConfirmation(intentId, provider, path, tx);
      }
      return updated;
    });
  }
  /// Contract: a timeout, 5xx or 429 is an unknown outcome, never a failure
  /// (INV-8); nothing changes and the next run asks again.
  private async fetchOrderPayments(
    gateway: PaymentGatewayProvider,
    orderId: string,
  ): Promise<GatePayment[]> {
    try {
      const { payment, additionalCaptures } = await gateway.fetchOrderPayments(orderId);
      if (!payment) return [];
      return [payment, ...additionalCaptures].map((p) => ({ kind: 'payment', payment: p }));
    } catch (err) {
      if (!isTransientProviderError(err)) throw err;
      logger.warn(
        { orderId, statusCode: (err as { statusCode?: number }).statusCode },
        '[payments] provider lookup failed; outcome unknown',
      );
      return [];
    }
  }
  /// The validation gate (T024): one decision per provider record, under the
  /// intent lock, from spec.md's rules. Only APPLY moves money.
  async applyConfirmation(
    intentId: string,
    provider: GateProvider,
    path: GatePath,
    tx: TransactionClient,
    verify?: GateInput['verify'],
  ): Promise<PaymentIntent> {
    const locked = await this.intentRepo.lockForUpdate(intentId, tx);
    if (!locked) throw new PaymentNotFoundError(intentId);
    if (provider.kind === 'unknown') return locked;
    const payment = provider.payment;
    // Decision R1: a payment is judged only against the intent that owns its
    // order. Another order's payment never changes this intent; it goes to its
    // owner, or to review as UNKNOWN_ORDER when no intent of ours owns it.
    if (payment.orderId !== (locked.gatewayIntentId ?? '')) {
      logger.warn(
        { intentId, providerPaymentId: payment.id, path },
        '[payments] payment for another order routed to its owning intent',
      );
      const owner = await this.intentRepo.findByGatewayIntentId(payment.orderId, tx);
      if (owner) await this.applyConfirmation(owner.id, provider, path, tx);
      else await this.reviewUnknownOrder(locked.gateway ?? 'mock', provider, path, tx);
      return locked;
    }
    const records = await this.intentRepo.findPaymentRecords(locked.gateway, payment.id, tx);
    const succeeded = await this.intentRepo.findSucceededPayment(intentId, tx);
    const decision = decidePaymentApplication({
      path,
      intent: {
        status: locked.status,
        orderId: locked.gatewayIntentId ?? '',
        amountPaise: toPaise(locked.amount),
        currency: locked.currency,
        succeededPaymentId: succeeded?.gatewayTxnId ?? null,
      },
      provider,
      paymentAppliedElsewhere: records.some(
        (r) => r.status === 'SUCCEEDED' && r.intentId !== intentId,
      ),
      paymentHeldOnIntent: records.some(
        (r) => r.status === 'CAPTURED_REVIEW' && r.intentId === intentId,
      ),
      ...(payment.status === 'refunded'
        ? { refundRecorded: await this.intentRepo.hasRefundFor(payment.id, tx) }
        : {}),
      ...(verify ? { verify } : {}),
    });
    this.auditGate(intentId, payment.id, decision, path);
    if (decision.outcome === 'REVIEW') {
      await this.holdForReview(
        locked,
        locked.gateway ?? 'mock',
        provider,
        decision,
        records,
        path,
        tx,
      );
      return (await this.intentRepo.findById(intentId, tx)) ?? locked;
    }
    if (decision.outcome !== 'APPLY' && decision.outcome !== 'MARK_FAILED') return locked;
    const nextStatus = decision.intentStatusAfter as string;
    if (decision.alert) {
      logger.warn(
        { alert: 'finance', intentId, providerPaymentId: payment.id },
        '[payments] capture applied to an EXPIRED intent',
      );
    }
    const gatewayTxnId = payment.id;
    this.validateTransition(locked.status, nextStatus);
    const intent = locked;
    const updated = await this.intentRepo.updateStatus(
      intentId,
      nextStatus,
      intent.gatewayIntentId,
      tx,
    );
    await this.intentRepo.recordTransaction(
      {
        intentId,
        userId: intent.userId,
        rideId: intent.rideId,
        txnType: 'PAYMENT',
        amount: intent.amount,
        status: nextStatus,
        gateway: intent.gateway,
        // Always the provider payment id (`pay_…`), never the order id (F-01).
        gatewayTxnId,
      },
      tx,
    );
    if (nextStatus === 'SUCCEEDED') {
      this.paymentMetrics.success({ intentId });
      // 004-driver-subscription-wallet. `purpose` decides the SUCCEEDED
      // effect instead of unconditionally crediting the customer wallet — the
      // pre-existing behavior below is preserved exactly for the default
      // ('CUSTOMER_WALLET_TOPUP') purpose, additive branches handle the two
      // new ones.
      const purpose = intent.purpose;
      if (purpose === 'DRIVER_COMMISSION_RECHARGE') {
        // `intent.userId` is the caller's AUTH user id (FK-constrained to
        // `users`, matching every other PaymentIntent) — NOT the same id space
        // as `DriverCommissionWallet.driverId` (`Driver.id`). Resolved here,
        // not trusted from anywhere else, so the wallet is always credited
        // under the exact id `CommissionWalletService.hasSufficientBalance`/
        // `deductInTx` will later look it up by.
        const driver = await this.driverRepository.findByUserId(intent.userId, tx);
        if (!driver) {
          throw new Error(
            `Cannot credit Commission Wallet: no driver profile for user ${intent.userId}`,
          );
        }
        await this.ledgerService.postTransactionGroup(
          [
            {
              account: 'GATEWAY_CLEARING',
              direction: 'DEBIT',
              amount: intent.amount,
              referenceType: 'PAYMENT_INTENT',
              referenceId: intentId,
              description: `Commission wallet recharge ${intentId} settled via gateway`,
            },
            {
              account: 'DRIVER_COMMISSION_WALLET',
              accountRefId: driver.id,
              direction: 'CREDIT',
              amount: intent.amount,
              referenceType: 'PAYMENT_INTENT',
              referenceId: intentId,
              description: `Commission wallet recharge ${intentId} credited`,
            },
          ],
          tx,
        );
        await this.commissionWalletService.creditInTx(driver.id, intent.amount, tx, {
          referenceType: 'PAYMENT_INTENT',
          referenceId: intentId,
          description: `Commission wallet funded by payment intent ${intentId}`,
        });
      } else if (purpose === 'DRIVER_SUBSCRIPTION_PAYMENT') {
        await this.ledgerService.postTransactionGroup(
          [
            {
              account: 'GATEWAY_CLEARING',
              direction: 'DEBIT',
              amount: intent.amount,
              referenceType: 'PAYMENT_INTENT',
              referenceId: intentId,
              description: `Subscription payment ${intentId} settled via gateway`,
            },
            {
              account: 'SUBSCRIPTION_REVENUE',
              direction: 'CREDIT',
              amount: intent.amount,
              referenceType: 'PAYMENT_INTENT',
              referenceId: intentId,
              description: `Subscription payment ${intentId} recognised`,
            },
          ],
          tx,
        );
        // Activation is NOT time-critical the way a wallet credit is, so it
        // goes through the outbox (constitution §1.5) rather than a direct
        // cross-module call — the subscriptions module's own consumer reacts.
        await this.eventPublisher.publish(
          paymentEvent(PAYMENT_EVENT_CATALOG.DRIVER_SUBSCRIPTION_PAYMENT_COMPLETED, intent.userId, {
            paymentIntentId: intentId,
            driverUserId: intent.userId,
            amount: intent.amount.toNumber(),
          }),
          tx,
        );
      } else {
        // CUSTOMER_WALLET_TOPUP — historical intents only. `createIntent` no
        // longer creates this purpose, but an intent created before that
        // change can still be captured and must still be credited.
        await this.ledgerService.postTransactionGroup(
          [
            {
              account: 'GATEWAY_CLEARING',
              direction: 'DEBIT',
              amount: intent.amount,
              referenceType: 'PAYMENT_INTENT',
              referenceId: intentId,
              description: `Payment intent ${intentId} settled via gateway`,
            },
            {
              account: 'CUSTOMER_WALLET',
              accountRefId: intent.userId,
              direction: 'CREDIT',
              amount: intent.amount,
              referenceType: 'PAYMENT_INTENT',
              referenceId: intentId,
              description: `Payment intent ${intentId} credited`,
            },
          ],
          tx,
        );
        // The balance moves here, in the same transaction as the ledger credit
        // above, and nowhere else. Previously `POST /wallet/topup` raised the
        // balance directly while this group was the only thing a provider
        // payment produced, so a request with no payment behind it minted
        // spendable balance and the two records could not agree (FR-036).
        await this.walletService.creditInTx(intent.userId, intent.amount, tx, {
          referenceType: 'PAYMENT_INTENT',
          referenceId: intentId,
          description: `Wallet funded by payment intent ${intentId}`,
        });
      }
      await this.eventPublisher.publish(
        paymentEvent(PAYMENT_EVENT_CATALOG.PAYMENT_SUCCEEDED, intent.userId, {
          intentId,
          amount: intent.amount.toNumber(),
        }),
        tx,
      );
    } else {
      this.paymentMetrics.failure({ intentId });
      await this.eventPublisher.publish(
        paymentEvent(PAYMENT_EVENT_CATALOG.PAYMENT_FAILED, intent.userId, {
          intentId,
          amount: intent.amount.toNumber(),
        }),
        tx,
      );
    }
    return updated;
  }
  /// contracts/http-api.md `checkout` for a freshly created or replayed intent,
  /// or null when its provider has no client checkout (the mock in development).
  async checkoutFor(intent: PaymentIntent, description: string): Promise<CheckoutPayload | null> {
    if (!intent.gateway || !intent.gatewayIntentId) return null;
    const gateway = await this.gatewayResolver.forProviderName(intent.gateway);
    const keyId = gateway.checkoutKeyId();
    if (!keyId) return null;
    // From our database for the intent's owner, never from the request (UD-9 a);
    // the email is Admin's company address, never the driver's own.
    const contact = await this.driverRepository.findPhoneByUserId(intent.userId);
    const { email } = await this.gatewayResolver.driverCheckoutSettings();
    return {
      provider: gateway.gatewayName,
      keyId,
      orderId: intent.gatewayIntentId,
      amount: toPaise(intent.amount),
      currency: intent.currency,
      name: CHECKOUT_MERCHANT_NAME,
      description,
      ...(contact ? { prefill: { contact, ...(email ? { email } : {}) } } : {}),
    };
  }
  /// The same key id every new order's `checkout` carries: the active gateway as
  /// admin settings (then env) configure it. The secret stays in the adapter.
  async checkoutConfig(): Promise<CheckoutConfigView> {
    let gateway: PaymentGatewayProvider;
    try {
      gateway = await this.gatewayResolver.getActiveGateway();
    } catch (err) {
      if (err instanceof PaymentGatewayNotConfiguredError) {
        return { checkout: null, checkoutError: { code: 'PAYMENT_GATEWAY_NOT_CONFIGURED' } };
      }
      if (err instanceof PaymentGatewayDisabledError) {
        return { checkout: null, checkoutError: { code: 'PAYMENT_GATEWAY_DISABLED' } };
      }
      throw err;
    }
    const keyId = gateway.checkoutKeyId();
    if (keyId === null) return { checkout: null, checkoutError: null };
    if (gateway.gatewayName === 'razorpay' && !RAZORPAY_KEY_ID.test(keyId)) {
      return { checkout: null, checkoutError: { code: 'PAYMENT_GATEWAY_NOT_CONFIGURED' } };
    }
    const { email, methods } = await this.gatewayResolver.driverCheckoutSettings();
    // Razorpay refuses every payment without an email: say so before the
    // driver picks a method, instead of letting each payment fail.
    if (gateway.gatewayName === 'razorpay' && !email) {
      return { checkout: null, checkoutError: { code: 'PAYMENT_EMAIL_NOT_SET' } };
    }
    return { checkout: { provider: gateway.gatewayName, keyId, methods }, checkoutError: null };
  }
  /// `GET /payments/intents/:intentId`: our database only, never the provider.
  async statusView(intent: PaymentIntent): Promise<IntentStatusView> {
    let status: IntentStatusView['status'];
    switch (intent.status) {
      case 'SUCCEEDED':
      case 'REFUND_PENDING':
        status = 'SUCCEEDED';
        break;
      case 'FAILED':
        status = 'FAILED';
        break;
      case 'EXPIRED':
        status = 'EXPIRED';
        break;
      case 'MANUAL_REVIEW':
        status = 'IN_REVIEW';
        break;
      case 'REFUNDED':
        status = 'REFUNDED';
        break;
      case 'CANCELLED':
        status = (await this.intentRepo.hasRefundResolvedReviewCase(intent.id))
          ? 'REFUNDED'
          : 'EXPIRED';
        break;
      default:
        status = 'PENDING'; // PENDING, PROCESSING, CREATED
    }
    let effect: IntentStatusView['effect'] = null;
    if (status === 'SUCCEEDED' && intent.purpose === 'DRIVER_COMMISSION_RECHARGE') {
      const balance = await this.intentRepo.findCommissionWalletBalance(intent.userId);
      if (balance) effect = { walletBalance: balance.toNumber() };
    } else if (status === 'SUCCEEDED' && intent.purpose === 'DRIVER_SUBSCRIPTION_PAYMENT') {
      // Activation commits later, in the outbox consumer: null until then.
      const sub = await this.intentRepo.findSubscriptionFundedBy(intent.id);
      if (sub && sub.status !== 'PENDING_PAYMENT') {
        effect = {
          subscriptionId: sub.id,
          subscriptionStatus: sub.status,
          startDate: sub.startDate,
          expiryDate: sub.expiryDate,
        };
      }
    }
    return {
      intentId: intent.id,
      purpose: intent.purpose,
      status,
      amount: intent.amount.toNumber(),
      currency: intent.currency,
      createdAt: intent.createdAt,
      effect,
      supportReference: `PAY-${intent.id.replace(/-/g, '').slice(-8).toUpperCase()}`,
    };
  }
  /// `POST /payments/intents/:intentId/verify` (contract steps 2–5, TD-4). The
  /// caller's ownership is checked by the controller. A valid signature only
  /// proves the callback came from checkout for OUR order; money moves only if
  /// the provider's own record of the payment passes the gate.
  async verifyCheckout(intent: PaymentIntent, callback: CheckoutCallback): Promise<PaymentIntent> {
    const storedOrderId = intent.gatewayIntentId ?? '';
    if (callback.razorpayOrderId !== storedOrderId) {
      this.securityEvent('order_mismatch', intent.id);
      throw new PaymentOrderMismatchError();
    }
    const gateway = await this.gatewayResolver.forProviderName(intent.gateway ?? 'mock');
    if (
      !gateway.verifyCheckoutSignature(
        storedOrderId,
        callback.razorpayPaymentId,
        callback.razorpaySignature,
      )
    ) {
      this.securityEvent('signature_invalid', intent.id);
      throw new PaymentSignatureInvalidError();
    }
    // Outside any transaction (constitution §4.2).
    let payment;
    try {
      payment = await gateway.fetchPayment(callback.razorpayPaymentId);
    } catch (err) {
      if (isTransientProviderError(err)) throw new PaymentGatewayUnavailableError();
      // A payment the provider does not know cannot be this order's (spec
      // failure table): same answer as a mismatch, nothing changes.
      this.securityEvent('payment_not_found', intent.id);
      throw new PaymentOrderMismatchError();
    }
    // Decision R1: another order's payment is rejected here, before the gate.
    if (payment.orderId !== storedOrderId) {
      this.securityEvent('order_mismatch', intent.id);
      throw new PaymentOrderMismatchError();
    }
    return this.txManager.execute((tx) =>
      this.applyConfirmation(intent.id, { kind: 'payment', payment }, 'VERIFY', tx, {
        callerOwnsIntent: true,
        signatureValid: true,
        callbackOrderId: callback.razorpayOrderId,
      }),
    );
  }
  private securityEvent(reason: string, intentId: string): void {
    this.paymentMetrics.verifyRejected({ reason });
    logger.warn({ security: true, intentId, reason }, '[payments] checkout verify rejected');
  }
  /// A9: a provider payment for an order no intent of ours has.
  async reviewUnknownOrder(
    gateway: string,
    provider: GatePayment,
    path: GatePath,
    tx: TransactionClient,
  ): Promise<void> {
    const decision = decidePaymentApplication({
      path,
      intent: null,
      provider,
      paymentAppliedElsewhere: false,
    });
    this.auditGate(null, provider.payment.id, decision, path);
    if (decision.outcome === 'REVIEW') {
      await this.holdForReview(null, gateway, provider, decision, [], path, tx);
    }
  }
  /// spec.md "Review": a durable case, MANUAL_REVIEW unless the intent is
  /// already SUCCEEDED, an alert, and no wallet, subscription or ledger
  /// effect. The ledger holding entry waits for UD-2, so none is posted.
  private async holdForReview(
    intent: PaymentIntent | null,
    gateway: string,
    provider: GatePayment,
    decision: GateDecision,
    records: { id: string; intentId: string; status: string }[],
    path: GatePath,
    tx: TransactionClient,
  ): Promise<void> {
    const payment = provider.payment;
    const kind = decision.reviewKind!;
    const observed = new Decimal(payment.amountPaise).div(100);
    // An existing record of this payment is linked, never duplicated: the
    // other intent's SUCCEEDED row (A6), or an earlier hold (redelivery).
    let paymentTransactionId =
      records.find((r) => r.status === 'SUCCEEDED')?.id ?? records[0]?.id ?? null;
    if (intent && !paymentTransactionId && HOLD_ROW_KINDS.has(kind)) {
      const held = await this.intentRepo.recordTransaction(
        {
          intentId: intent.id,
          userId: intent.userId,
          rideId: intent.rideId,
          txnType: 'PAYMENT',
          amount: observed,
          currency: payment.currency,
          status: 'CAPTURED_REVIEW',
          gateway,
          gatewayTxnId: payment.id,
        },
        tx,
      );
      paymentTransactionId = held.id;
    }
    if (intent && decision.intentStatusAfter && intent.status !== decision.intentStatusAfter) {
      this.validateTransition(intent.status, decision.intentStatusAfter);
      await this.intentRepo.updateStatus(intent.id, decision.intentStatusAfter, null, tx);
    }
    const opened = await this.paymentReviewCaseRepo.openIfAbsent(
      {
        kind,
        intentId: intent?.id ?? null,
        paymentTransactionId,
        gateway,
        providerPaymentId: payment.id,
        providerOrderId: payment.orderId || null,
        expectedAmount: intent?.amount ?? null,
        observedAmount: observed,
        expectedCurrency: intent?.currency ?? null,
        observedCurrency: payment.currency,
        evidence: {
          id: payment.id,
          order_id: payment.orderId,
          amount: payment.amountPaise,
          currency: payment.currency,
          status: payment.status,
          ...(provider.orderAmountPaidPaise !== undefined
            ? { order_amount_paid: provider.orderAmountPaidPaise }
            : {}),
          rule: decision.rule,
          path,
          // UD-2 open: no holding entry is posted, so the ledger and Razorpay
          // disagree by this payment until Finance decides.
          ledger: 'NOT_POSTED_UD2_OPEN',
        },
      },
      tx,
    );
    if (opened) {
      this.paymentMetrics.amountMismatch({ kind });
      logger.warn(
        { alert: 'finance', kind, intentId: intent?.id ?? null, providerPaymentId: payment.id },
        '[payments] captured payment held for review',
      );
    }
  }
  /// FR-035: one line per gate run with a provider record. Ids, rule and
  /// outcome only; no payload, VPA, card, email or contact data.
  private auditGate(
    intentId: string | null,
    providerPaymentId: string,
    decision: GateDecision,
    path: GatePath,
  ): void {
    logger.info(
      {
        audit: 'payment_gate',
        intentId,
        providerPaymentId,
        rule: decision.rule,
        outcome: decision.outcome,
        path,
      },
      '[payments] gate decision',
    );
  }
}

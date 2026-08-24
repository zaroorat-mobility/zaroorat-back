import { config } from '../config.js';
import { numericEnv } from '../env/numeric.js';
export type PaymentGatewayName = 'mock' | 'razorpay' | 'stripe';
const GATEWAYS: readonly PaymentGatewayName[] = ['mock', 'razorpay', 'stripe'];
const LIVE_GATEWAYS: readonly PaymentGatewayName[] = ['razorpay', 'stripe'];
export const MOCK_WEBHOOK_SECRET = 'mock-gateway-webhook-secret-not-for-live-use';
export interface PaymentConfig {
  defaultCurrency: string;
  defaultGateway: PaymentGatewayName;
  idempotencyTtlSeconds: number;
  razorpayKeyId?: string | undefined;
  razorpayKeySecret?: string | undefined;
  stripeSecretKey?: string | undefined;
  webhookSecret: string;
  webhookToleranceSeconds: number;

  /// Collection retry bounds (BD-4). No combination of these may produce an
  /// unbounded retry loop, which is why the attempt cap carries a maximum.
  collectionMaxAttempts: number;
  collectionRetryBaseSeconds: number;

  /// Outstanding-receivable threshold above which a rider may not create a new
  /// ride request (BD-2). The comparison is `>=` — *reaches or exceeds*.
  /// It never gates settling an existing obligation.
  riderDebtLimit: number;

  /// Cash confirmation rollout (BD-5). Defaults OFF; see `readCashConfirmationRequired`.
  cashConfirmationRequired: boolean;

  /// Grace period after which an unconfirmed cash ride resolves automatically
  /// (BD-6). Without this, never confirming would let a driver keep the cash
  /// and avoid the commission.
  cashConfirmGraceSeconds: number;

  /// Ageing period after which an outstanding receivable is written off to
  /// BAD_DEBT_EXPENSE (BD-1c). Deliberately not hard-coded.
  receivableWriteOffDays: number;

  /// Prospective-only ledger correction boundary (BD-7). Reconciliation scopes
  /// its live comparison to entries at or after this instant; entries before it
  /// are reported separately as historical and uncorrected, never rewritten.
  ledgerCutoverAt: Date;
}
function readGateway(): PaymentGatewayName {
  const raw = process.env.PAYMENT_DEFAULT_GATEWAY;
  const environment = config.app.environment;
  if (raw == null || raw === '') {
    return environment === 'production' || environment === 'staging' ? 'razorpay' : 'mock';
  }
  if (!GATEWAYS.includes(raw as PaymentGatewayName)) {
    throw new Error(`PAYMENT_DEFAULT_GATEWAY must be one of ${GATEWAYS.join(', ')}`);
  }
  return raw as PaymentGatewayName;
}
function readWebhookSecret(gateway: PaymentGatewayName): string {
  const secret = process.env.PAYMENT_WEBHOOK_SECRET;
  if (LIVE_GATEWAYS.includes(gateway)) {
    if (secret == null || secret.trim() === '') {
      throw new Error(
        `PAYMENT_WEBHOOK_SECRET is required when PAYMENT_DEFAULT_GATEWAY=${gateway}. ` +
          'A live gateway must never verify signatures against a built-in secret.',
      );
    }
    return secret;
  }
  return secret != null && secret.trim() !== '' ? secret : MOCK_WEBHOOK_SECRET;
}
/// BD-5 approved cash confirmation as feature-flagged and **default OFF**.
///
/// The house idiom for a boolean knob is `process.env.X !== 'false'`, which
/// defaults ON. Using it here would silently invert an approved business
/// decision, so this reads the opposite way on purpose. With the flag off,
/// cash rides behave exactly as they do today and the confirmation route is
/// never registered — a client cannot access or execute the flow at all.
function readCashConfirmationRequired(): boolean {
  return process.env.PAYMENT_CASH_CONFIRMATION_REQUIRED === 'true';
}

/// The live reading of the BD-5 flag, for the code paths the flag actually
/// gates.
///
/// Everything else in this module is a boot-time snapshot, and rightly so —
/// a fare rate that changed under a running process would be a bug. A rollout
/// flag is the opposite: it exists to be turned on, and reading it per call is
/// what lets that happen without a redeploy (and what lets a test cover both
/// states in one process).
export function cashConfirmationRequired(): boolean {
  return readCashConfirmationRequired();
}

/// BD-7 cut-over instant. `numericEnv` does not cover timestamps, so this
/// follows `readWebhookSecret`'s precedent instead: an unusable value stops the
/// process at import time rather than silently disabling the boundary that
/// keeps historical ledger noise out of the live reconciliation alarm.
function readLedgerCutoverAt(): Date {
  const raw = process.env.PAYMENT_LEDGER_CUTOVER_AT;
  if (raw == null || raw.trim() === '') {
    // Absent means "correct everything from now on" — the epoch would drag
    // known-bad historical entries into the live alarm.
    return new Date();
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      `Invalid configuration: PAYMENT_LEDGER_CUTOVER_AT=${JSON.stringify(raw)} — ` +
        'expected an ISO-8601 timestamp. Remove it to cut over from process start.',
    );
  }
  return parsed;
}

export function getPaymentConfig(): PaymentConfig {
  const defaultGateway = readGateway();
  return {
    defaultCurrency: process.env.PAYMENT_DEFAULT_CURRENCY ?? 'INR',
    defaultGateway,
    idempotencyTtlSeconds: numericEnv('PAYMENT_IDEMPOTENCY_TTL', 86400, {
      min: 60,
      integer: true,
    }),
    razorpayKeyId: process.env.RAZORPAY_KEY_ID,
    razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET,
    stripeSecretKey: process.env.STRIPE_SECRET_KEY,
    webhookSecret: readWebhookSecret(defaultGateway),
    webhookToleranceSeconds: numericEnv('PAYMENT_WEBHOOK_TOLERANCE_SEC', 300, {
      min: 30,
      max: 3600,
      integer: true,
    }),
    collectionMaxAttempts: numericEnv('PAYMENT_COLLECTION_MAX_ATTEMPTS', 5, {
      min: 1,
      max: 20,
      integer: true,
    }),
    collectionRetryBaseSeconds: numericEnv('PAYMENT_COLLECTION_RETRY_BASE_SEC', 300, {
      min: 30,
      max: 86400,
      integer: true,
    }),
    riderDebtLimit: numericEnv('PAYMENT_RIDER_DEBT_LIMIT', 500, { min: 0 }),
    cashConfirmationRequired: readCashConfirmationRequired(),
    cashConfirmGraceSeconds: numericEnv('PAYMENT_CASH_CONFIRM_GRACE_SEC', 3600, {
      min: 60,
      integer: true,
    }),
    receivableWriteOffDays: numericEnv('PAYMENT_RECEIVABLE_WRITEOFF_DAYS', 90, {
      min: 1,
      integer: true,
    }),
    ledgerCutoverAt: readLedgerCutoverAt(),
  };
}
export const paymentConfig: PaymentConfig = Object.freeze(getPaymentConfig());

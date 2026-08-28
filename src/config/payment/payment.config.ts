import { config } from '../config.js';
import { numericEnv } from '../env/numeric.js';
export type PaymentGatewayName = 'mock' | 'razorpay' | 'stripe';
const GATEWAYS: readonly PaymentGatewayName[] = ['mock', 'razorpay', 'stripe'];
const LIVE_GATEWAYS: readonly PaymentGatewayName[] = ['razorpay', 'stripe'];

const UNIMPLEMENTED_GATEWAYS: readonly PaymentGatewayName[] = ['mock', 'razorpay', 'stripe'];

export function assertGatewayImplemented(gateway: PaymentGatewayName, environment: string): void {
  if (environment !== 'production' && environment !== 'staging') return;
  if (!UNIMPLEMENTED_GATEWAYS.includes(gateway)) return;
  throw new Error(
    `PAYMENT_DEFAULT_GATEWAY=${gateway} cannot be used in ${environment}: its provider is a ` +
      'placeholder that performs no network call and reports every charge as successful. ' +
      'Running it here would report money as collected that was never collected. ' +
      'Implement the provider and remove it from UNIMPLEMENTED_GATEWAYS in ' +
      'src/config/payment/payment.config.ts before deploying to this environment.',
  );
}
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

  collectionMaxAttempts: number;
  collectionRetryBaseSeconds: number;

  riderDebtLimit: number;

  cashConfirmationRequired: boolean;

  cashConfirmGraceSeconds: number;

  receivableWriteOffDays: number;

  ledgerCutoverAt: Date;
}
function readGateway(): PaymentGatewayName {
  const raw = process.env.PAYMENT_DEFAULT_GATEWAY;
  const environment = config.app.environment;
  if (raw == null || raw === '') {
    const implied: PaymentGatewayName =
      environment === 'production' || environment === 'staging' ? 'razorpay' : 'mock';
    assertGatewayImplemented(implied, environment);
    return implied;
  }
  if (!GATEWAYS.includes(raw as PaymentGatewayName)) {
    throw new Error(`PAYMENT_DEFAULT_GATEWAY must be one of ${GATEWAYS.join(', ')}`);
  }
  assertGatewayImplemented(raw as PaymentGatewayName, environment);
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

function readCashConfirmationRequired(): boolean {
  return process.env.PAYMENT_CASH_CONFIRMATION_REQUIRED === 'true';
}

export function cashConfirmationRequired(): boolean {
  return readCashConfirmationRequired();
}

function readLedgerCutoverAt(): Date {
  const raw = process.env.PAYMENT_LEDGER_CUTOVER_AT;
  if (raw == null || raw.trim() === '') {
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

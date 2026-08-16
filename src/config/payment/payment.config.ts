import { config } from '../config.js';
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
export function getPaymentConfig(): PaymentConfig {
  const defaultGateway = readGateway();
  return {
    defaultCurrency: process.env.PAYMENT_DEFAULT_CURRENCY ?? 'INR',
    defaultGateway,
    idempotencyTtlSeconds: Number(process.env.PAYMENT_IDEMPOTENCY_TTL ?? 86400),
    razorpayKeyId: process.env.RAZORPAY_KEY_ID,
    razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET,
    stripeSecretKey: process.env.STRIPE_SECRET_KEY,
    webhookSecret: readWebhookSecret(defaultGateway),
    webhookToleranceSeconds: Number(process.env.PAYMENT_WEBHOOK_TOLERANCE_SEC ?? 300),
  };
}
export const paymentConfig: PaymentConfig = Object.freeze(getPaymentConfig());

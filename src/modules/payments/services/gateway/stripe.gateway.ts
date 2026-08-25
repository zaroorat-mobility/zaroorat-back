import { randomUUID } from 'node:crypto';
import { Decimal } from '../../types/index.js';
import type {
  PaymentGatewayProvider,
  CreateGatewayIntentInput,
  GatewayIntentResult,
  GatewayRefundResult,
  GatewayPayoutResult,
} from './gateway.provider.js';
/// A placeholder, not an integration: it makes no network call and reports
/// every charge as successful. `UNIMPLEMENTED_GATEWAYS` in
/// `src/config/payment/payment.config.ts` is what stops it being selected in a
/// money-taking environment — remove it from that list only when the methods
/// below actually reach the provider.
export class StripeGatewayProvider implements PaymentGatewayProvider {
  readonly gatewayName = 'stripe';
  constructor(private readonly secretKey?: string) {}
  async createIntent(_input: CreateGatewayIntentInput): Promise<GatewayIntentResult> {
    return {
      gatewayIntentId: `pi_stripe_${randomUUID()}`,
      clientSecret: `pi_stripe_secret_${randomUUID()}`,
      status: 'PENDING',
    };
  }
  async confirmIntent(gatewayIntentId: string): Promise<GatewayIntentResult> {
    return {
      gatewayIntentId,
      status: 'SUCCEEDED',
    };
  }
  async createRefund(
    _transactionId: string,
    _amount: Decimal,
    _idempotencyKey: string,
  ): Promise<GatewayRefundResult> {
    return {
      gatewayRefundId: `re_stripe_${randomUUID()}`,
      status: 'SUCCEEDED',
    };
  }
  async createPayout(
    _driverId: string,
    _bankAccountId: string,
    _amount: Decimal,
    _idempotencyKey: string,
  ): Promise<GatewayPayoutResult> {
    return {
      gatewayPayoutId: `po_stripe_${randomUUID()}`,
      status: 'COMPLETED',
    };
  }
}

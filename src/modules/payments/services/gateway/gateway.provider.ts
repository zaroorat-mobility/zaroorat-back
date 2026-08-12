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

export interface GatewayRefundResult {
  gatewayRefundId: string;
  status: string;
}

export interface GatewayPayoutResult {
  gatewayPayoutId: string;
  status: string;
}

export interface PaymentGatewayProvider {
  readonly gatewayName: string;

  createIntent(input: CreateGatewayIntentInput): Promise<GatewayIntentResult>;
  confirmIntent(gatewayIntentId: string): Promise<GatewayIntentResult>;
  createRefund(
    transactionId: string,
    amount: Decimal,
    idempotencyKey: string,
  ): Promise<GatewayRefundResult>;
  createPayout(
    driverId: string,
    bankAccountId: string,
    amount: Decimal,
    idempotencyKey: string,
  ): Promise<GatewayPayoutResult>;
}

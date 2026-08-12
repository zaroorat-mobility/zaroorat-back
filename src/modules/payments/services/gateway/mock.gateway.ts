import { randomUUID } from 'node:crypto';
import { Decimal } from '../../types/index.js';
import type {
  PaymentGatewayProvider,
  CreateGatewayIntentInput,
  GatewayIntentResult,
  GatewayRefundResult,
  GatewayPayoutResult,
} from './gateway.provider.js';

export class MockGatewayProvider implements PaymentGatewayProvider {
  readonly gatewayName = 'mock';

  async createIntent(_input: CreateGatewayIntentInput): Promise<GatewayIntentResult> {
    return {
      gatewayIntentId: `mock_pi_${randomUUID()}`,
      clientSecret: `mock_secret_${randomUUID()}`,
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
      gatewayRefundId: `mock_rf_${randomUUID()}`,
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
      gatewayPayoutId: `mock_po_${randomUUID()}`,
      status: 'COMPLETED',
    };
  }
}

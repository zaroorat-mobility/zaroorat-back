import { randomUUID } from 'node:crypto';
import type {
  PaymentGatewayProvider,
  CreateGatewayIntentInput,
  CreateGatewayRefundInput,
  GatewayIntentResult,
  GatewayRefundResult,
} from './gateway.provider.js';

/// Test/development control over the mock's refund behaviour. The mock
/// gateway can never run in staging or production (`assertGatewayImplemented`),
/// so this only ever steers local runs and the test suite.
///   SUCCEED - provider refunds immediately.   PENDING - accepted, not final.
///   REJECT  - definitive 4xx refusal.         TIMEOUT - outcome unknown, nothing created.
///   CREATE_THEN_TIMEOUT - the refund IS created, but the response is lost.
export type MockRefundMode = 'SUCCEED' | 'PENDING' | 'REJECT' | 'TIMEOUT' | 'CREATE_THEN_TIMEOUT';
export const mockGatewayControl = {
  refundMode: 'SUCCEED' as MockRefundMode,
  refunds: new Map<string, GatewayRefundResult & { providerPaymentId: string; amount: string }>(),
  createRefundCalls: [] as CreateGatewayRefundInput[],
  reset(): void {
    this.refundMode = 'SUCCEED';
    this.refunds.clear();
    this.createRefundCalls.length = 0;
  },
};

function providerError(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { statusCode });
}
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
  async createRefund(input: CreateGatewayRefundInput): Promise<GatewayRefundResult> {
    mockGatewayControl.createRefundCalls.push(input);
    const mode = mockGatewayControl.refundMode;
    if (mode === 'TIMEOUT') throw providerError('mock refund timed out', 504);
    if (mode === 'REJECT') throw providerError('mock refund rejected', 400);
    // Idempotent on the reference, like a real provider with an idempotency key.
    const existing = mockGatewayControl.refunds.get(input.refundReference);
    if (existing) return { gatewayRefundId: existing.gatewayRefundId, status: existing.status };
    const created: GatewayRefundResult = {
      gatewayRefundId: `mock_rf_${randomUUID()}`,
      status: mode === 'PENDING' ? 'PENDING' : 'SUCCEEDED',
    };
    mockGatewayControl.refunds.set(input.refundReference, {
      ...created,
      providerPaymentId: input.providerPaymentId,
      amount: input.amount.toFixed(2),
    });
    if (mode === 'CREATE_THEN_TIMEOUT') throw providerError('mock refund response lost', 504);
    return created;
  }
  async findRefund(
    _providerPaymentId: string,
    refundReference: string,
  ): Promise<GatewayRefundResult | null> {
    const found = mockGatewayControl.refunds.get(refundReference);
    return found ? { gatewayRefundId: found.gatewayRefundId, status: found.status } : null;
  }
}

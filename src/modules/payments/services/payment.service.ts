import { WalletService } from './wallet/wallet.service.js';
import { IntentService } from './intent/intent.service.js';
import { RefundService } from './refund/refund.service.js';
import { PayoutService } from './payout/payout.service.js';
import { SettlementService } from './settlement/settlement.service.js';
import { WebhookService } from './webhook/webhook.service.js';
import { IdempotencyRepository } from '../repositories/idempotency.repository.js';
import { IdempotencyKeyRequiredError } from '../errors/payment.errors.js';
import { paymentConfig } from '@config';

export class PaymentService {
  constructor(
    public readonly wallet: WalletService,
    public readonly intent: IntentService,
    public readonly refund: RefundService,
    public readonly payout: PayoutService,
    public readonly settlement: SettlementService,
    public readonly webhook: WebhookService,
    private readonly idempotencyRepo: IdempotencyRepository,
  ) {}

  async withIdempotency<T>(
    userId: string,
    route: string,
    key: string | undefined,
    payload: unknown,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (key == null || key.trim() === '') {
      throw new IdempotencyKeyRequiredError();
    }
    const ttl = paymentConfig.idempotencyTtlSeconds ?? 86400;
    const { result } = await this.idempotencyRepo.runIdempotent(
      userId,
      route,
      key,
      payload,
      ttl,
      operation,
    );
    return result;
  }
}

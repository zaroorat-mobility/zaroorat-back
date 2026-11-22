import { RedisService } from '@core/cache/RedisService.js';
import { logger } from '@shared/logger/index.js';
import { RefundService } from '../services/refund/refund.service.js';

/// Phase 1 refunds. A refund whose provider outcome is unknown — a timeout, a
/// provider 5xx, or a database failure after the provider accepted it — stays
/// PROCESSING with its reservation held. This job asks the provider again
/// through `RefundService`, with the SAME refund reference, so it finds the
/// provider's refund if one exists and never creates a second one.
export class RefundReconciliationJob {
  constructor(
    private readonly refundService: RefundService,
    private readonly redis: RedisService,
  ) {}

  async run(
    now: Date = new Date(),
  ): Promise<{ scanned: number; resolved: number; stillProcessing: number }> {
    const lockToken = await this.redis.lock.acquire('job:refund-reconciliation', 120_000);
    if (!lockToken) {
      logger.info('Refund reconciliation lock held by another process');
      return { scanned: 0, resolved: 0, stillProcessing: 0 };
    }
    try {
      return await this.refundService.reconcileStale(now);
    } finally {
      await this.redis.lock.release('job:refund-reconciliation', lockToken);
    }
  }
}

import { RedisService } from '@core/cache/RedisService.js';
import { SettlementService } from '../services/settlement/settlement.service.js';
import { logger } from '@shared/logger/index.js';

export class SettlementJob {
  constructor(
    private readonly settlementService: SettlementService,
    private readonly redis: RedisService,
  ) {}

  async run(driverIds: string[], periodStart: Date, periodEnd: Date): Promise<void> {
    const lockToken = await this.redis.lock.acquire('job:settlement', 30000);
    if (!lockToken) {
      logger.info('Settlement job lock held by another process');
      return;
    }

    try {
      for (const driverId of driverIds) {
        try {
          await this.settlementService.calculateSettlement({
            driverId,
            periodStart,
            periodEnd,
          });
        } catch (err) {
          logger.error({ driverId, err }, 'Failed calculating settlement');
        }
      }
    } finally {
      await this.redis.lock.release('job:settlement', lockToken);
    }
  }
}

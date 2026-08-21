import { SettlementService } from '../services/settlement/settlement.service.js';
import { RedisService } from '@core/cache/RedisService.js';
import { logger } from '@shared/logger/index.js';
function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
export class SettlementJob {
  constructor(
    private readonly settlementService: SettlementService,
    private readonly redis: RedisService,
  ) {}
  /// Settles the previous full UTC day, run daily. Matches the
  /// `MaintenanceRunner` shape (`run(now)`) so it can be scheduled and
  /// dispatched the same way every other maintenance job is — previously this
  /// method required an explicit, externally-supplied driver list that
  /// nothing in the codebase ever produced, which was the entire reason
  /// settlement never ran in production.
  async run(now: Date = new Date()): Promise<number> {
    const lockToken = await this.redis.lock.acquire('job:settlement', 60000);
    if (!lockToken) {
      logger.info('Settlement job lock held by another process');
      return 0;
    }
    try {
      const periodEnd = startOfUtcDay(now);
      const periodStart = new Date(periodEnd.getTime() - 24 * 60 * 60 * 1000);
      return await this.settlementService.calculateSettlementsForPeriod(periodStart, periodEnd);
    } finally {
      await this.redis.lock.release('job:settlement', lockToken);
    }
  }
}

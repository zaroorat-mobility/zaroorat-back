import { DatabaseService } from '@core/database';
import { RedisService } from '@core/cache/RedisService.js';
import { RideMetrics } from '../metrics/ride.metrics.js';
import { logger } from '@shared/logger/index.js';

export class DispatchTimeoutJob {
  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly rideMetrics: RideMetrics,
  ) {}

  async run(): Promise<number> {
    const lockToken = await this.redis.lock.acquire('job:dispatch_timeout', 15000);
    if (!lockToken) return 0;

    let expiredCount = 0;

    try {
      const now = new Date();
      const timedOutDispatches = await this.db.client.rideDispatch.findMany({
        where: {
          response: 'PENDING',
          expiresAt: { lte: now },
        },
      });

      for (const dispatch of timedOutDispatches) {
        await this.db.client.rideDispatch.update({
          where: { id: dispatch.id },
          data: {
            response: 'TIMEOUT',
            respondedAt: now,
          },
        });
        expiredCount++;
        this.rideMetrics.dispatchTimeout({ dispatchId: dispatch.id, driverId: dispatch.driverId });
      }
    } catch (err) {
      logger.error({ err }, 'Error running dispatch timeout job');
    } finally {
      await this.redis.lock.release('job:dispatch_timeout', lockToken);
    }

    return expiredCount;
  }
}

import { DatabaseService } from '@core/database';
import { RedisService } from '@core/cache/RedisService.js';
import { logger } from '@shared/logger/index.js';
export class RequestExpiryJob {
  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
  ) {}
  async run(): Promise<number> {
    const lockToken = await this.redis.lock.acquire('job:request_expiry', 15000);
    if (!lockToken) return 0;
    let expiredCount = 0;
    try {
      const now = new Date();
      const expiredRequests = await this.db.client.rideRequest.findMany({
        where: {
          status: { in: ['CREATED', 'SEARCHING'] },
          expiresAt: { lte: now },
        },
      });
      for (const request of expiredRequests) {
        await this.db.client.rideRequest.update({
          where: { id: request.id },
          data: { status: 'EXPIRED' },
        });
        expiredCount++;
      }
    } catch (err) {
      logger.error({ err }, 'Error running request expiry job');
    } finally {
      await this.redis.lock.release('job:request_expiry', lockToken);
    }
    return expiredCount;
  }
}

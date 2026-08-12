import { DatabaseService } from '@core/database';
import { RedisService } from '@core/cache/RedisService.js';
import { DriverStatusRepository } from '../repositories/driver-status.repository.js';
import { StatusService } from '../services/status/status.service.js';
import { driverConfig } from '@config';
import { logger } from '@shared/logger/index.js';

export class HeartbeatTimeoutJob {
  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly statusRepo: DriverStatusRepository,
    private readonly statusService: StatusService,
  ) {}

  async run(): Promise<number> {
    const lockToken = await this.redis.lock.acquire('job:driver_heartbeat_timeout', 15000);
    if (!lockToken) return 0;

    let timeoutCount = 0;

    try {
      const now = new Date();
      const thresholdDate = new Date(now.getTime() - driverConfig.heartbeatTimeoutSeconds * 1000);

      const staleStatuses = await this.statusRepo.findStaleDrivers(thresholdDate);

      for (const statusRow of staleStatuses) {
        try {
          await this.statusService.setOffline(statusRow.driverId, 'HEARTBEAT_TIMEOUT');
          timeoutCount++;
        } catch (err) {
          logger.warn(
            { err, driverId: statusRow.driverId },
            'Failed to set stale driver offline in heartbeat timeout job',
          );
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error running heartbeat timeout job');
    } finally {
      await this.redis.lock.release('job:driver_heartbeat_timeout', lockToken);
    }

    return timeoutCount;
  }
}

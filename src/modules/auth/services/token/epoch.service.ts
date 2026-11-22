import { RedisService } from '@core/cache';
export class EpochService {
  constructor(private readonly redisService: RedisService) {}
  async current(userId: string): Promise<number> {
    return this.redisService.epoch.get(userId);
  }
  async bump(userId: string): Promise<number> {
    return this.redisService.epoch.bump(userId);
  }
}

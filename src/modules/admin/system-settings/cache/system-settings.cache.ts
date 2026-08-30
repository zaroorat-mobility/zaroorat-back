import { RedisService } from '@core/cache';
import { logger } from '@shared/logger/index.js';
import { MAP_SETTINGS_CACHE_KEY } from '../map/constants/map-settings.constants.js';

export class SystemSettingsCache {
  constructor(private readonly redisService: RedisService) {}

  async clearMapSettingsCache(): Promise<void> {
    try {
      await this.redisService.provider.client.del(MAP_SETTINGS_CACHE_KEY);
    } catch (err) {
      logger.warn({ err }, '[SystemSettingsCache] Failed to clear map settings cache');
    }
  }

  async getMapSettingsCache<T>(): Promise<T | null> {
    try {
      const raw = await this.redisService.provider.client.get(MAP_SETTINGS_CACHE_KEY);
      if (!raw) return null;
      return JSON.parse(raw) as T;
    } catch (err) {
      logger.warn({ err }, '[SystemSettingsCache] Failed to read map settings cache');
      return null;
    }
  }

  async setMapSettingsCache(data: unknown, ttlSeconds = 3600): Promise<void> {
    try {
      await this.redisService.provider.client.set(
        MAP_SETTINGS_CACHE_KEY,
        JSON.stringify(data),
        'EX',
        ttlSeconds,
      );
    } catch (err) {
      logger.warn({ err }, '[SystemSettingsCache] Failed to write map settings cache');
    }
  }
}

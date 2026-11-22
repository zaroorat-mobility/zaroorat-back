import { RedisService } from '@core/cache';
import { logger } from '@shared/logger/index.js';
import {
  APP_CONFIG_CACHE_PREFIX,
  APP_CONFIG_CACHE_TTL_SECONDS,
  cacheKey,
} from '../constants/app-config.constants.js';

export class AppConfigCache {
  constructor(private readonly redisService: RedisService) {}

  async getBundle<T>(app: string, locale: string, version: number): Promise<T | null> {
    try {
      const raw = await this.redisService.provider.client.get(cacheKey(app, locale, version));
      if (!raw) return null;
      return JSON.parse(raw) as T;
    } catch (err) {
      logger.warn({ err, app, locale, version }, '[AppConfigCache] Failed to read bundle cache');
      return null;
    }
  }

  async setBundle(
    app: string,
    locale: string,
    version: number,
    data: unknown,
    ttl = APP_CONFIG_CACHE_TTL_SECONDS,
  ): Promise<void> {
    try {
      await this.redisService.provider.client.set(
        cacheKey(app, locale, version),
        JSON.stringify(data),
        'EX',
        ttl,
      );
    } catch (err) {
      logger.warn({ err, app, locale, version }, '[AppConfigCache] Failed to write bundle cache');
    }
  }

  async purgeAll(): Promise<void> {
    try {
      const redis = this.redisService.provider.client;
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(
          cursor,
          'MATCH',
          `${APP_CONFIG_CACHE_PREFIX}:*`,
          'COUNT',
          100,
        );
        cursor = next;
        if (keys.length > 0) {
          await redis.del(...keys);
        }
      } while (cursor !== '0');
    } catch (err) {
      logger.warn({ err }, '[AppConfigCache] Failed to purge app_config cache keys');
    }
  }
}

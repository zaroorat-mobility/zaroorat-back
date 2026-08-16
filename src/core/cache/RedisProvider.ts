import type { Redis } from 'ioredis';
import { redis } from './client';
import { logger } from '@shared/logger/index.js';
export interface RedisHealth {
  healthy: boolean;
  latency: number;
  timestamp: Date;
}
export class RedisProvider {
  private readonly _client: Redis = redis;
  get client(): Redis {
    return this._client;
  }
  async health(): Promise<RedisHealth> {
    const start = performance.now();
    try {
      const pong = await this._client.ping();
      return {
        healthy: pong === 'PONG',
        latency: Math.round(performance.now() - start),
        timestamp: new Date(),
      };
    } catch (error) {
      logger.error({ error }, '[Redis Health] Health check failed');
      return {
        healthy: false,
        latency: Math.round(performance.now() - start),
        timestamp: new Date(),
      };
    }
  }
}

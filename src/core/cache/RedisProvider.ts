import type { Redis } from 'ioredis';
import { redis } from './client';
import { logger } from '@shared/logger/index.js';

export interface RedisHealth {
  healthy: boolean;
  latency: number;
  timestamp: Date;
}

/**
 * Infrastructure owner of the Redis connection for the application layer.
 *
 * Wraps the shared ioredis client (`./client`) so services and stores depend on
 * an injectable owner rather than a module-level global — mirroring
 * `PrismaClientProvider` for the database. The connection lifecycle (connect on
 * boot, quit on shutdown) remains owned by the bootstrap steps; this class adds
 * the operational health probe and the single access point to the client.
 */
export class RedisProvider {
  private readonly _client: Redis = redis;

  /** The shared ioredis client used by every store. */
  get client(): Redis {
    return this._client;
  }

  /**
   * Operational health check (Kubernetes readiness / observability).
   * @returns Health status with round-trip latency; never throws.
   */
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

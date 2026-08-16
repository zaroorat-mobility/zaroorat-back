import type { Redis } from 'ioredis';
import { RedisProvider } from '../RedisProvider';
import { RedisKeys } from '../keys';
export interface RateLimitResult {
  allowed: boolean;
  current: number;
  remaining: number;
  retryAfterSeconds: number;
}
export class RateLimitStore {
  private readonly client: Redis;
  private static readonly HIT_LUA = `
    local count = redis.call('INCR', KEYS[1])
    if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
    return {count, redis.call('TTL', KEYS[1])}`;
  constructor(redisProvider: RedisProvider) {
    this.client = redisProvider.client;
  }
  async hit(
    scope: string,
    id: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitResult> {
    const key = RedisKeys.rateLimit(scope, id);
    const [current, ttl] = (await this.client.eval(
      RateLimitStore.HIT_LUA,
      1,
      key,
      String(windowSeconds),
    )) as [number, number];
    return {
      allowed: current <= limit,
      current,
      remaining: Math.max(0, limit - current),
      retryAfterSeconds: ttl > 0 ? ttl : windowSeconds,
    };
  }
  async enforceMinInterval(
    scope: string,
    id: string,
    intervalSeconds: number,
  ): Promise<{
    allowed: boolean;
    retryAfterSeconds: number;
  }> {
    const key = RedisKeys.rateLimit(`${scope}:gap`, id);
    const set = await this.client.set(key, '1', 'EX', intervalSeconds, 'NX');
    if (set === 'OK') return { allowed: true, retryAfterSeconds: 0 };
    const ttl = await this.client.ttl(key);
    return { allowed: false, retryAfterSeconds: ttl > 0 ? ttl : intervalSeconds };
  }
}

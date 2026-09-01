import Redis from 'ioredis';
import { config } from '@config';
declare global {
  var redis: Redis | undefined;
}
/// Exported so the Socket.IO redis adapter can take its own pub and sub
/// connections. The adapter's subscriber enters subscriber mode, where a
/// connection may issue nothing but (un)subscribe commands, so it must never
/// share the application client below.
export function createRedisClient(): Redis {
  return new Redis(config.redis.url, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });
}
export const redis = global.redis || createRedisClient();
if (process.env.NODE_ENV !== 'production') {
  global.redis = redis;
}
export default redis;

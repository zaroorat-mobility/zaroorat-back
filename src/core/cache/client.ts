import Redis from 'ioredis';
import { config } from '@config';

declare global {
  var redis: Redis | undefined;
}

function createRedisClient(): Redis {
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

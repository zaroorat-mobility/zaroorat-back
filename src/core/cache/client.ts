import Redis from 'ioredis';
import { config } from '@config';

declare global {
  var redis: Redis | undefined;
}

function createRedisClient(): Redis {
  return new Redis(config.redis.url, {
    // Connect explicitly from the bootstrap step so a failure surfaces there
    // rather than on the first command issued while serving a request.
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    // Without a ceiling this backs off indefinitely and readiness never
    // reports the dependency as down.
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });
}

// Reuse one client across hot reloads; each construction opens its own socket.
export const redis = global.redis || createRedisClient();

if (process.env.NODE_ENV !== 'production') {
  global.redis = redis;
}

export default redis;

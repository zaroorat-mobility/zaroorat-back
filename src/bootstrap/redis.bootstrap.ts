import { redis } from '@core/cache/client.js';
import { registerReadinessCheck } from '@core/health/index.js';
import { logger } from '@shared/logger/index.js';

export async function bootstrapRedis(): Promise<void> {
  // The client is lazyConnect, so this is where a bad REDIS_URL fails fast
  // instead of surfacing on the first cache read during a request.
  await redis.connect();

  logger.info('Redis connected successfully');

  registerReadinessCheck({
    name: 'redis',
    probe: async () => {
      const reply = await redis.ping();

      if (reply !== 'PONG') {
        throw new Error(`unexpected PING reply: ${reply}`);
      }
    },
  });
}

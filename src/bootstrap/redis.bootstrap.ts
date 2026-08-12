import { redis } from '@core/cache/client.js';
import { registerReadinessCheck } from '@core/health/index.js';
import { logger } from '@shared/logger/index.js';

export async function bootstrapRedis(): Promise<void> {
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

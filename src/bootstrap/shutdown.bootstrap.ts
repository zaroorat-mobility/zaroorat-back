import { FastifyInstance } from 'fastify';

import { redis } from '@core/cache/client.js';
import { DatabaseService } from '@core/database/index.js';

export async function bootstrapShutdown(app: FastifyInstance): Promise<void> {
  // SIGTERM can arrive twice (kubelet, then the container runtime). Without
  // this guard the second signal re-enters shutdown while the first is still
  // draining and kills in-flight requests.
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    app.log.info(`Received ${signal}. Gracefully shutting down...`);

    try {
      // 1. Stop accepting new requests and drain what is in flight.
      await app.close();
      app.log.info('Fastify server closed.');

      // 2. Only then release the backing connections — closing them first
      //    would fail the requests still being drained above.
      await DatabaseService.disconnect();

      await redis.quit();
      app.log.info('Redis connection closed.');

      process.exit(0);
    } catch (err) {
      app.log.error(err, 'Error during graceful shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

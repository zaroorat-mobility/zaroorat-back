import { FastifyInstance } from 'fastify';
import { redis } from '@core/cache/client.js';
import { container } from '../core/di.js';
import { PrismaClientProvider } from '@core/database/client/PrismaClientProvider.js';
import { OutboxRelay } from '@core/events';
import { RealtimeGateway } from '@modules/realtime';
export async function bootstrapShutdown(app: FastifyInstance): Promise<void> {
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`Received ${signal}. Gracefully shutting down...`);
    try {
      // Disconnect clients first: closing Fastify out from under a live socket
      // server leaves engine.io polling handles open and the process hanging.
      await container.resolve<RealtimeGateway>('realtimeGateway').close();
      app.log.info('Realtime gateway closed.');
      await app.close();
      app.log.info('Fastify server closed.');
      await container.resolve<OutboxRelay>('outboxRelay').stop();
      app.log.info('Outbox relay stopped.');
      const provider = container.resolve<PrismaClientProvider>('provider');
      await provider.disconnect();
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

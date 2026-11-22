import { FastifyInstance } from 'fastify';
import { config } from '@config';
import { redis } from '@core/cache/client.js';
import { markDraining } from '@core/health/index.js';
import { container } from '../core/di.js';
import { PrismaClientProvider } from '@core/database/client/PrismaClientProvider.js';
import { OutboxRelay } from '@core/events';
import { RealtimeGateway } from '@modules/realtime';
export async function bootstrapShutdown(app: FastifyInstance): Promise<void> {
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    markDraining();
    app.log.info(`Received ${signal}. Draining for ${config.server.shutdownDrainMs}ms...`);
    const forceExit = setTimeout(() => {
      app.log.error('Shutdown grace period elapsed. Exiting.');
      process.exit(1);
    }, config.server.shutdownGraceMs);
    forceExit.unref();
    try {
      // Still serving: the balancer sees /ready fail and stops routing here.
      await new Promise((resolve) => setTimeout(resolve, config.server.shutdownDrainMs));
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

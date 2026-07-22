import { FastifyInstance } from 'fastify';

export async function bootstrapShutdown(app: FastifyInstance): Promise<void> {
  const shutdown = async (signal: string) => {
    app.log.info(`Received ${signal}. Gracefully shutting down...`);

    try {
      // 1. Stop accepting new requests & close Fastify
      await app.close();
      app.log.info('Fastify server closed.');

      // 2. Later: Close Database
      // 3. Later: Close Redis

      process.exit(0);
    } catch (err) {
      app.log.error(err, 'Error during graceful shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

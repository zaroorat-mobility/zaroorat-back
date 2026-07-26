import { config } from '@config';
import { bootstrapDatabase } from './database.bootstrap.js';
import { bootstrapRedis } from './redis.bootstrap.js';
import { bootstrapQueue } from './queue.bootstrap.js';
import { bootstrapStorage } from './storage.bootstrap.js';
import { createApp } from '../app/index.js';
import { bootstrapShutdown } from './shutdown.bootstrap.js';

export async function startup() {
  try {
    await bootstrapDatabase();
    await bootstrapRedis();
    await bootstrapQueue();
    await bootstrapStorage();

    const app = await createApp();

    await bootstrapShutdown(app);

    await app.listen({
      port: config.server.port,
      host: config.server.host,
    });

    app.log.info(`Server listening on http://${config.server.host}:${config.server.port}`);
    app.log.info(`Environment: ${config.app.environment}`);

    return app;
  } catch (err) {
    console.error('Failed to start application orchestration:', err);
    process.exit(1);
  }
}

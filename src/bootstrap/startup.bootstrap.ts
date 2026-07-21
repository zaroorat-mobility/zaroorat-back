import { config } from '@config';
import { bootstrapDatabase } from './database.bootstrap.js';
import { bootstrapRedis } from './redis.bootstrap.js';
import { bootstrapQueue } from './queue.bootstrap.js';
import { bootstrapStorage } from './storage.bootstrap.js';
import { createApp } from '../app/index.js';
import { bootstrapRoutes } from './routes.bootstrap.js';
import { bootstrapShutdown } from './shutdown.bootstrap.js';

export async function startup() {
  try {
    // 1. Environment is already loaded at import time via @config
    
    // 2. Connect Infrastructure (Milestone 2)
    await bootstrapDatabase();
    await bootstrapRedis();
    await bootstrapQueue();
    await bootstrapStorage();
    
    // 3. Initialize Fastify Application with Pino Logger (including core plugins)
    const app = await createApp();
    
    // 6. Register Routes
    await bootstrapRoutes(app);
    
    // 7. Register Graceful Shutdown
    await bootstrapShutdown(app);
    
    // 8. Start Listening
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

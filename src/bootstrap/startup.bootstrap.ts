import { env } from '@config';
import { bootstrapLogger } from './logger.bootstrap.js';
import { bootstrapDatabase } from './database.bootstrap.js';
import { bootstrapRedis } from './redis.bootstrap.js';
import { bootstrapQueue } from './queue.bootstrap.js';
import { bootstrapStorage } from './storage.bootstrap.js';
import { bootstrapApplication } from './application.bootstrap.js';
import { bootstrapPlugins } from './plugins.bootstrap.js';
import { bootstrapRoutes } from './routes.bootstrap.js';
import { bootstrapShutdown } from './shutdown.bootstrap.js';

export async function startup() {
  try {
    // 1. Environment is already loaded at import time via @config
    
    // 2. Initialize Logger
    const loggerOptions = await bootstrapLogger();
    
    // 3. Connect Infrastructure (Milestone 2)
    await bootstrapDatabase();
    await bootstrapRedis();
    await bootstrapQueue();
    await bootstrapStorage();
    
    // 4. Initialize Fastify Application
    const app = await bootstrapApplication(loggerOptions);
    
    // 5. Register Plugins
    await bootstrapPlugins(app);
    
    // 6. Register Routes
    await bootstrapRoutes(app);
    
    // 7. Register Graceful Shutdown
    await bootstrapShutdown(app);
    
    // 8. Start Listening
    await app.listen({
      port: env.server.port,
      host: env.server.host,
    });
    
    app.log.info(`Server listening on http://${env.server.host}:${env.server.port}`);
    app.log.info(`Environment: ${env.app.environment}`);
    
    return app;
  } catch (err) {
    console.error('Failed to start application orchestration:', err);
    process.exit(1);
  }
}

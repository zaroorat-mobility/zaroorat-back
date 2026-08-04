import { config } from '@config';
import { bootstrapDatabase } from './database.bootstrap.js';
import { bootstrapRedis } from './redis.bootstrap.js';
import { bootstrapStorage } from './storage.bootstrap.js';
import { bootstrapEvents } from './events.bootstrap.js';
import { createApp } from '../app/index.js';
import { bootstrapShutdown } from './shutdown.bootstrap.js';

export async function startup() {
  try {
    await bootstrapDatabase();
    await bootstrapRedis();
    await bootstrapEvents();
    // No `bootstrapQueue()` here: background jobs run in their own process
    // (`src/worker.ts`, handbook volume 08 §31) and that process owns their
    // schedules. The API enqueues nothing today; when it does, it opens the
    // queue lazily at the call site.
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

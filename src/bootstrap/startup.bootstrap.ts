import { config } from '@config';
import { bootstrapDatabase } from './database.bootstrap.js';
import { bootstrapRedis } from './redis.bootstrap.js';
import { bootstrapStorage } from './storage.bootstrap.js';
import { bootstrapEvents } from './events.bootstrap.js';
import { createApp } from '../app/index.js';
import { bootstrapShutdown } from './shutdown.bootstrap.js';
import { container } from '../core/di.js';
import { RealtimeGateway } from '@modules/realtime';
export async function startup() {
  try {
    await bootstrapDatabase();
    await bootstrapRedis();
    await bootstrapEvents();
    await bootstrapStorage();
    const app = await createApp();
    await bootstrapShutdown(app);
    await app.listen({
      port: config.server.port,
      host: config.server.host,
    });
    // Sockets ride on the HTTP server Fastify just bound, so there is one port,
    // one TLS terminator and one CORS policy for both transports. Attached after
    // listen() because that is when `app.server` is actually bound.
    container.resolve<RealtimeGateway>('realtimeGateway').attach(app.server);
    app.log.info(`Server listening on http://${config.server.host}:${config.server.port}`);
    app.log.info(`Environment: ${config.app.environment}`);
    return app;
  } catch (err) {
    console.error('Failed to start application orchestration:', err);
    process.exit(1);
  }
}

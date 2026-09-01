import Fastify, { type FastifyInstance, type FastifyBaseLogger, LogController } from 'fastify';
import { logger } from '@shared/logger/index.js';
import { registerPlugins } from '../plugins/register.js';
import { registerHooks } from '../hooks/register.js';
import { registerRoutes } from '../routes/register.js';
import { errorHandler, notFoundHandler } from '../core/errors/index.js';
export async function createApp(): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: logger as FastifyBaseLogger,
    logController: new LogController({
      // Fastify's own request logging is off because `on-request.hook` and
      // `on-response.hook` already log both ends. With it on, every request
      // produced FOUR lines — Fastify's "incoming request"/"request completed"
      // and the hooks' "Incoming request"/"Request completed" — differing only
      // in capitalisation. The hooks are the ones kept: they carry the
      // requestId, a duration measured with `process.hrtime.bigint()` rather
      // than Fastify's coarser `elapsedTime`, and the http_requests_total
      // counter.
      disableRequestLogging: true,
      requestIdLogLabel: 'requestId',
    }),
    requestIdHeader: 'x-request-id',
    trustProxy: Number(process.env.TRUSTED_PROXY_HOPS ?? 1),
    bodyLimit: 10 * 1024 * 1024,
  });
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);
  await registerPlugins(app);
  await registerHooks(app);
  await registerRoutes(app);
  return app;
}

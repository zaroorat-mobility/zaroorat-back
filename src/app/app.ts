import Fastify, {
  type FastifyInstance,
  type FastifyBaseLogger,
  LogController,
} from "fastify";

import { config } from "@config";
import { logger } from "@shared/logger/index.js";
import { registerPlugins } from "../plugins/register.js";
import { registerHooks } from "../hooks/register.js";
import { registerRoutes } from "../routes/register.js";
import { errorHandler, notFoundHandler } from "../core/errors/index.js";

export async function createApp(): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: logger as FastifyBaseLogger,

    logController: new LogController({
      disableRequestLogging: false,
      requestIdLogLabel: "requestId",
    }),

    requestIdHeader: "x-request-id",

    trustProxy: true,

    bodyLimit: 10 * 1024 * 1024,
  });

  await registerPlugins(app);
  await registerHooks(app);
  await registerRoutes(app);

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  return app;
}

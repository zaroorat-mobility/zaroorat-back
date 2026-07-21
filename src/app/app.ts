import Fastify, { type FastifyInstance } from "fastify";

import { config } from "@config";
import { logger } from "@shared/logger/index.js";
import { registerPlugins } from "../plugins/register.js";

export async function createApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: logger as any,

    disableRequestLogging: false,

    requestIdHeader: "x-request-id",

    requestIdLogLabel: "requestId",

    trustProxy: true,

    bodyLimit: 10 * 1024 * 1024,
  });

  await registerPlugins(app);

  return app;
}

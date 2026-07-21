import { FastifyInstance } from "fastify";

import helmetPlugin from "./helmet/helmet.plugin.js";
import corsPlugin from "./cors/cors.plugin.js";
import sensiblePlugin from "./sensible/sensible.plugin.js";

export async function registerPlugins(app: FastifyInstance): Promise<void> {
  await app.register(helmetPlugin);
  await app.register(corsPlugin);
  await app.register(sensiblePlugin);
}

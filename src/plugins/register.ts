import { FastifyInstance } from 'fastify';

import helmetPlugin from './helmet/helmet.plugin.js';
import corsPlugin from './cors/cors.plugin.js';
import sensiblePlugin from './sensible/sensible.plugin.js';
import { authPlugin } from '@modules/auth/http';

export async function registerPlugins(app: FastifyInstance): Promise<void> {
  await app.register(helmetPlugin);
  await app.register(corsPlugin);
  await app.register(sensiblePlugin);
  // Auth guard decorators (app.authenticate / app.authorize) — consumed by routes.
  await app.register(authPlugin);
}

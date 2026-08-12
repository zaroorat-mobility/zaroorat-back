import { FastifyInstance } from 'fastify';

import helmetPlugin from './helmet/helmet.plugin.js';
import corsPlugin from './cors/cors.plugin.js';
import sensiblePlugin from './sensible/sensible.plugin.js';
import swaggerPlugin from './swagger/swagger.plugin.js';
import rateLimitPlugin from './rate-limit/rate-limit.plugin.js';
import { authPlugin } from '@modules/auth/http';

export async function registerPlugins(app: FastifyInstance): Promise<void> {
  await app.register(swaggerPlugin);
  await app.register(helmetPlugin);
  await app.register(corsPlugin);
  await app.register(sensiblePlugin);

  await app.register(rateLimitPlugin);

  await app.register(authPlugin);
}

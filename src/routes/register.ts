import { FastifyInstance } from 'fastify';
import { healthRoute } from './health/health.route.js';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(healthRoute, { prefix: '/api/v1' });
  await app.register(healthRoute); // Also register at root for basic load balancers
}

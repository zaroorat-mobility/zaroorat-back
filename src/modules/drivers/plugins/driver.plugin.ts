import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { driverRoutes } from '../routes/driver.routes.js';
export async function driverPlugin(
  fastify: FastifyInstance,
  _opts: FastifyPluginOptions,
): Promise<void> {
  await fastify.register(driverRoutes, { prefix: '/api/v1/drivers' });
}

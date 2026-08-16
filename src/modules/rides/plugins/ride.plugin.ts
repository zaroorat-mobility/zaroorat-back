import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { rideRoutes } from '../routes/ride.routes.js';
export async function ridePlugin(
  fastify: FastifyInstance,
  _opts: FastifyPluginOptions,
): Promise<void> {
  await fastify.register(rideRoutes, { prefix: '/api/v1/rides' });
}

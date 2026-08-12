import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { paymentRoutes } from '../routes/payment.routes.js';

export async function paymentPlugin(
  fastify: FastifyInstance,
  _opts: FastifyPluginOptions,
): Promise<void> {
  await fastify.register(paymentRoutes, { prefix: '/api/v1/payments' });
}

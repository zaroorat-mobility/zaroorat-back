import type { FastifyInstance } from 'fastify';
import { container } from '@core/di';
import { rateLimits } from '@config';
import { AdminPaymentManagementController } from './payment-management.controller.js';

export async function adminPaymentRoutes(fastify: FastifyInstance): Promise<void> {
  const controller = container.resolve<AdminPaymentManagementController>(
    'adminPaymentManagementController',
  );

  fastify.post(
    '/payments/payouts',
    {
      preHandler: [
        fastify.authorize({ permissions: ['finance:execute'] }),
        fastify.rateLimit(rateLimits.payment),
      ],
    },
    (req, reply) => controller.executePayout(req, reply),
  );
}

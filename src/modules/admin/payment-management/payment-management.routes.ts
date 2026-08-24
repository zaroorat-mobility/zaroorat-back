import type { FastifyInstance } from 'fastify';
import { container } from '@core/di';
import { rateLimits } from '@config';
import { AdminPaymentManagementController } from './payment-management.controller.js';
import { handlePaymentError } from '@modules/payments/schemas/error-response.js';

export async function adminPaymentRoutes(fastify: FastifyInstance): Promise<void> {
  // Error handlers are scoped to the Fastify plugin that registers them. These
  // routes moved here from their domain module and left its handler behind, so
  // coded domain errors were falling through to the global handler and losing
  // their code/status/details. Restored per constitution S13.3.
  fastify.setErrorHandler(handlePaymentError);

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

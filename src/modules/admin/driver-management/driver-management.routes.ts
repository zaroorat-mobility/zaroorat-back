import type { FastifyInstance } from 'fastify';
import { container } from '@core/di';
import { AdminDriverManagementController } from './driver-management.controller.js';
import { handleDriverError } from '@modules/drivers/schemas/error-response.js';

export async function adminDriverRoutes(fastify: FastifyInstance): Promise<void> {
  // Error handlers are scoped to the Fastify plugin that registers them. These
  // routes moved here from their domain module and left its handler behind, so
  // coded domain errors were falling through to the global handler and losing
  // their code/status/details. Restored per constitution S13.3.
  fastify.setErrorHandler(handleDriverError);

  const controller = container.resolve<AdminDriverManagementController>(
    'adminDriverManagementController',
  );

  fastify.post(
    '/drivers/:driverId/documents/:documentId/review',
    { preHandler: fastify.authorize({ permissions: ['drivers:verify'] }) },
    (req, reply) => controller.reviewDocument(req, reply),
  );

  fastify.post(
    '/drivers/:id/verify',
    { preHandler: fastify.authorize({ permissions: ['drivers:verify'] }) },
    (req, reply) => controller.reviewVerification(req, reply),
  );

  fastify.post(
    '/drivers/:id/suspend',
    { preHandler: fastify.authorize({ permissions: ['drivers:suspend'] }) },
    (req, reply) => controller.suspend(req, reply),
  );
}

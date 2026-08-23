import type { FastifyInstance } from 'fastify';
import { container } from '@core/di';
import { AdminDriverManagementController } from './driver-management.controller.js';

export async function adminDriverRoutes(fastify: FastifyInstance): Promise<void> {
  const controller = container.resolve<AdminDriverManagementController>(
    'adminDriverManagementController',
  );

  fastify.post(
    '/drivers/:driverId/documents/:documentId/review',
    { preHandler: fastify.authorize({ roles: ['admin'] }) },
    (req, reply) => controller.reviewDocument(req, reply),
  );

  fastify.post(
    '/drivers/:id/verify',
    { preHandler: fastify.authorize({ roles: ['admin'] }) },
    (req, reply) => controller.reviewVerification(req, reply),
  );

  fastify.post(
    '/drivers/:id/suspend',
    { preHandler: fastify.authorize({ roles: ['admin'] }) },
    (req, reply) => controller.suspend(req, reply),
  );
}

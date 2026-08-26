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
  const canRead = { preHandler: fastify.authorize({ permissions: ['drivers:read'] }) };
  const canVerify = { preHandler: fastify.authorize({ permissions: ['drivers:verify'] }) };
  const canWrite = { preHandler: fastify.authorize({ permissions: ['drivers:write'] }) };

  fastify.get('/applications', canRead, (req, reply) => controller.listApplications(req, reply));
  fastify.get('/applications/:id', canRead, (req, reply) =>
    controller.getApplicationById(req, reply),
  );
  fastify.post('/applications/:id/approve', canVerify, (req, reply) =>
    controller.approveApplication(req, reply),
  );
  fastify.post('/applications/:id/reject', canVerify, (req, reply) =>
    controller.rejectApplication(req, reply),
  );
  fastify.post('/applications/:id/request-resubmission', canVerify, (req, reply) =>
    controller.requestApplicationResubmission(req, reply),
  );
  fastify.post('/applications/:id/documents/:documentId/review', canVerify, (req, reply) =>
    controller.reviewApplicationDocument(req, reply),
  );

  fastify.get('/drivers', canRead, (req, reply) => controller.list(req, reply));
  fastify.get('/drivers/:id', canRead, (req, reply) => controller.getById(req, reply));

  fastify.post('/drivers/:driverId/documents/:documentId/review', canVerify, (req, reply) =>
    controller.reviewDocument(req, reply),
  );

  fastify.post('/drivers/:id/verify', canVerify, (req, reply) =>
    controller.reviewVerification(req, reply),
  );

  fastify.post('/drivers/:id/suspend', canWrite, (req, reply) => controller.suspend(req, reply));
  fastify.post('/drivers/:id/block', canWrite, (req, reply) => controller.block(req, reply));
  fastify.post('/drivers/:id/activate', canWrite, (req, reply) => controller.activate(req, reply));
}

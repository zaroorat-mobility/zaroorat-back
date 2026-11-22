import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { container } from '@core/di';
import { errorEnvelope, isCodedError } from '@core/errors/envelope.js';
import { AdminReferralController } from './referral.controller.js';

function handleReferralError(err: unknown, request: FastifyRequest, reply: FastifyReply): void {
  if (err instanceof ZodError) {
    reply.status(400).send(
      errorEnvelope('VALIDATION', 'Request validation failed', request.id, {
        details: err.issues,
      }),
    );
    return;
  }
  if (isCodedError(err) && err.statusCode < 500) {
    reply.status(err.statusCode).send(errorEnvelope(err.code, err.message, request.id));
    return;
  }
  request.log.error({ err }, '[admin-referral] unhandled error');
  reply
    .status(500)
    .send(errorEnvelope('INTERNAL', 'An unexpected referral admin error occurred', request.id));
}

export async function referralManagementRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.setErrorHandler(handleReferralError);

  const controller = container.resolve<AdminReferralController>('adminReferralController');
  const canRead = { preHandler: fastify.authorize({ permissions: ['referrals:read'] }) };
  const canWrite = { preHandler: fastify.authorize({ permissions: ['referrals:write'] }) };

  // Programs (configuration)
  fastify.get('/referral-programs', canRead, (req, reply) => controller.listPrograms(req, reply));
  fastify.get('/referral-programs/:id', canRead, (req, reply) => controller.getProgram(req, reply));
  fastify.post('/referral-programs', canWrite, (req, reply) =>
    controller.createProgram(req, reply),
  );
  fastify.patch('/referral-programs/:id', canWrite, (req, reply) =>
    controller.updateProgram(req, reply),
  );
  fastify.post('/referral-programs/:id/activate', canWrite, (req, reply) =>
    controller.activateProgram(req, reply),
  );
  fastify.post('/referral-programs/:id/deactivate', canWrite, (req, reply) =>
    controller.deactivateProgram(req, reply),
  );

  // Milestones
  fastify.post('/referral-programs/:id/milestones', canWrite, (req, reply) =>
    controller.addMilestone(req, reply),
  );
  fastify.patch('/referral-milestones/:id', canWrite, (req, reply) =>
    controller.updateMilestone(req, reply),
  );
  fastify.post('/referral-milestones/:id/deactivate', canWrite, (req, reply) =>
    controller.deactivateMilestone(req, reply),
  );
  fastify.post('/referral-milestones/:id/activate', canWrite, (req, reply) =>
    controller.activateMilestone(req, reply),
  );

  // Codes
  fastify.get('/referral-codes', canRead, (req, reply) => controller.listCodes(req, reply));
  fastify.post('/referral-codes/:id/activate', canWrite, (req, reply) =>
    controller.activateCode(req, reply),
  );
  fastify.post('/referral-codes/:id/deactivate', canWrite, (req, reply) =>
    controller.deactivateCode(req, reply),
  );

  // History
  fastify.get('/referrals', canRead, (req, reply) => controller.listReferrals(req, reply));
  fastify.get('/referrals/:id', canRead, (req, reply) => controller.getReferral(req, reply));
}

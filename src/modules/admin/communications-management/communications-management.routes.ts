import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { container } from '@core/di';
import { errorEnvelope, isCodedError } from '@core/errors/envelope.js';
import { AdminCommunicationsController } from './communications.controller.js';

function handleCommunicationsError(
  err: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
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
  request.log.error({ err }, '[admin-communications] unhandled error');
  reply
    .status(500)
    .send(
      errorEnvelope('INTERNAL', 'An unexpected communications admin error occurred', request.id),
    );
}

export async function communicationsManagementRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.setErrorHandler(handleCommunicationsError);

  const controller = container.resolve<AdminCommunicationsController>(
    'adminCommunicationsController',
  );
  const canRead = { preHandler: fastify.authorize({ permissions: ['communications:read'] }) };
  const canWrite = { preHandler: fastify.authorize({ permissions: ['communications:write'] }) };

  fastify.get('/templates', canRead, (req, reply) => controller.listTemplates(req, reply));
  fastify.post('/templates', canWrite, (req, reply) => controller.createTemplate(req, reply));
  fastify.put('/templates/:id', canWrite, (req, reply) => controller.updateTemplate(req, reply));

  fastify.get('/history', canRead, (req, reply) => controller.listHistory(req, reply));

  fastify.post('/push/send', canWrite, (req, reply) => controller.sendPush(req, reply));
  fastify.post('/push/schedule', canWrite, (req, reply) => controller.schedulePush(req, reply));
  fastify.get('/push/history', canRead, (req, reply) => controller.listPushHistory(req, reply));
  fastify.post('/push/:id/retry', canWrite, (req, reply) => controller.retryPush(req, reply));
}

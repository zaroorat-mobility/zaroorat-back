import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { container } from '@core/di';
import { errorEnvelope, isCodedError } from '@core/errors/envelope.js';
import { AdminGeographicController } from './geographic.controller.js';

function handleGeographicError(err: unknown, request: FastifyRequest, reply: FastifyReply): void {
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
  request.log.error({ err }, '[admin-geographic] unhandled error');
  reply
    .status(500)
    .send(errorEnvelope('INTERNAL', 'An unexpected geographic admin error occurred', request.id));
}

export async function geographicManagementRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.setErrorHandler(handleGeographicError);

  const controller = container.resolve<AdminGeographicController>('adminGeographicController');
  const canRead = { preHandler: fastify.authorize({ permissions: ['geography:read'] }) };
  const canWrite = { preHandler: fastify.authorize({ permissions: ['geography:write'] }) };

  fastify.get('/countries', canRead, (req, reply) => controller.listCountries(req, reply));
  fastify.get('/states', canRead, (req, reply) => controller.listStates(req, reply));
  fastify.post('/states', canWrite, (req, reply) => controller.createState(req, reply));
  fastify.patch('/states/:id', canWrite, (req, reply) => controller.updateState(req, reply));

  fastify.get('/cities', canRead, (req, reply) => controller.listCities(req, reply));
  fastify.get('/cities/:id', canRead, (req, reply) => controller.getCity(req, reply));
  fastify.post('/cities', canWrite, (req, reply) => controller.createCity(req, reply));
  fastify.patch('/cities/:id', canWrite, (req, reply) => controller.updateCity(req, reply));

  fastify.get('/service-zones', canRead, (req, reply) => controller.listServiceZones(req, reply));
  fastify.get('/service-zones/:id', canRead, (req, reply) => controller.getServiceZone(req, reply));
  fastify.post('/service-zones', canWrite, (req, reply) =>
    controller.createServiceZone(req, reply),
  );
  fastify.patch('/service-zones/:id', canWrite, (req, reply) =>
    controller.updateServiceZone(req, reply),
  );
  fastify.post('/service-zones/:id/activate', canWrite, (req, reply) =>
    controller.activateServiceZone(req, reply),
  );
  fastify.post('/service-zones/:id/deactivate', canWrite, (req, reply) =>
    controller.deactivateServiceZone(req, reply),
  );
}

import type { FastifyInstance } from 'fastify';
import { container } from '@core/di';
import { AdminRiderController } from './rider.controller.js';

export async function adminRiderRoutes(fastify: FastifyInstance): Promise<void> {
  const controller = container.resolve<AdminRiderController>('adminRiderController');
  const canRead = { preHandler: fastify.authorize({ permissions: ['riders:read'] }) };
  const canWrite = { preHandler: fastify.authorize({ permissions: ['riders:write'] }) };

  fastify.get('/riders', canRead, (req, reply) => controller.list(req, reply));
  fastify.get('/riders/:id', canRead, (req, reply) => controller.getById(req, reply));
  fastify.post('/riders/:id/suspend', canWrite, (req, reply) => controller.suspend(req, reply));
  fastify.post('/riders/:id/block', canWrite, (req, reply) => controller.block(req, reply));
  fastify.post('/riders/:id/activate', canWrite, (req, reply) => controller.activate(req, reply));
}

import type { FastifyInstance } from 'fastify';
import { container } from '@core/di';
import { AdminStaffController } from './staff.controller.js';

export async function adminStaffRoutes(fastify: FastifyInstance): Promise<void> {
  const controller = container.resolve<AdminStaffController>('adminStaffController');
  const adminOnly = { preHandler: fastify.authorize({ roles: ['admin'] }) };

  fastify.get('/users', adminOnly, (req, reply) => controller.list(req, reply));
  fastify.get('/users/:id', adminOnly, (req, reply) => controller.getById(req, reply));
  fastify.post('/users', adminOnly, (req, reply) => controller.create(req, reply));
  fastify.delete('/users/:id', adminOnly, (req, reply) => controller.remove(req, reply));
}

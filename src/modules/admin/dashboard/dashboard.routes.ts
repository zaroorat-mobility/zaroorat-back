import type { FastifyInstance } from 'fastify';
import { container } from '@core/di';
import { AdminDashboardController } from './dashboard.controller.js';

export async function dashboardRoutes(fastify: FastifyInstance): Promise<void> {
  const controller = container.resolve<AdminDashboardController>('adminDashboardController');
  const canRead = { preHandler: fastify.authorize({ permissions: ['operations:read'] }) };

  fastify.get('/stats', canRead, (req, reply) => controller.getStats(req, reply));
}

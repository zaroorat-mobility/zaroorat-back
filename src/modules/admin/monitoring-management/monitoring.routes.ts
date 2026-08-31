import type { FastifyInstance } from 'fastify';
import { container } from '@core/di';
import { AdminMonitoringController } from './monitoring.controller.js';

export async function monitoringManagementRoutes(fastify: FastifyInstance): Promise<void> {
  const controller = container.resolve<AdminMonitoringController>('adminMonitoringController');
  const canRead = { preHandler: fastify.authorize({ permissions: ['monitoring:read'] }) };

  fastify.get('/health', canRead, (req, reply) => controller.getHealth(req, reply));
  fastify.get('/performance', canRead, (req, reply) => controller.getPerformance(req, reply));
  fastify.get('/errors', canRead, (req, reply) => controller.getErrors(req, reply));
  fastify.get('/alerts', canRead, (req, reply) => controller.getAlerts(req, reply));
  fastify.post('/alerts/:id/ack', canRead, (req, reply) => controller.ackAlert(req, reply));
}

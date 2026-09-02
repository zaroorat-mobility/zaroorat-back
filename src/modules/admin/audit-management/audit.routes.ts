import type { FastifyInstance } from 'fastify';
import { container } from '@core/di';
import { AdminAuditController } from './audit.controller.js';

export async function auditManagementRoutes(fastify: FastifyInstance): Promise<void> {
  const controller = container.resolve<AdminAuditController>('adminAuditController');
  const canRead = { preHandler: fastify.authorize({ permissions: ['audit:read'] }) };

  fastify.get('/logs', canRead, (req, reply) => controller.listLogs(req, reply));
}

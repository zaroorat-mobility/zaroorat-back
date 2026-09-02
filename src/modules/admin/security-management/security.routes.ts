import type { FastifyInstance } from 'fastify';
import { container } from '@core/di';
import { AdminSecurityController } from './security.controller.js';

export async function securityManagementRoutes(fastify: FastifyInstance): Promise<void> {
  const controller = container.resolve<AdminSecurityController>('adminSecurityController');
  const canRead = { preHandler: fastify.authorize({ permissions: ['security:read'] }) };
  const canWrite = { preHandler: fastify.authorize({ permissions: ['security:write'] }) };

  fastify.get('/sessions', canRead, (req, reply) => controller.listSessions(req, reply));
  fastify.post('/sessions/:id/revoke', canWrite, (req, reply) =>
    controller.revokeSession(req, reply),
  );
  fastify.post('/force-logout-all', canWrite, (req, reply) =>
    controller.forceLogoutAll(req, reply),
  );
  fastify.get('/login-history', canRead, (req, reply) => controller.listLoginHistory(req, reply));
  fastify.get('/events', canRead, (req, reply) => controller.listEvents(req, reply));
  fastify.get('/policy', canRead, (req, reply) => controller.getPolicy(req, reply));
  fastify.put('/policy', canWrite, (req, reply) => controller.updatePolicy(req, reply));
}

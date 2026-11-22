import type { FastifyInstance } from 'fastify';
import { container } from '@core/di';
import { AdminRbacController } from './rbac.controller.js';

export async function adminRbacRoutes(fastify: FastifyInstance): Promise<void> {
  const controller = container.resolve<AdminRbacController>('adminRbacController');
  const manage = { preHandler: fastify.authorize({ permissions: ['rbac:manage'] }) };

  fastify.get('/rbac/permissions', manage, (req, reply) => controller.listPermissions(req, reply));
  fastify.get('/rbac/roles', manage, (req, reply) => controller.listRoles(req, reply));
  fastify.post('/rbac/roles', manage, (req, reply) => controller.createRole(req, reply));
  fastify.put('/rbac/roles/:slug/permissions', manage, (req, reply) =>
    controller.replaceRolePermissions(req, reply),
  );
}

import type { FastifyInstance } from 'fastify';
import { container } from '@core/di';
import { AdminMapSettingsController } from '../map/controllers/admin-map-settings.controller.js';

export async function systemSettingsRoutes(fastify: FastifyInstance): Promise<void> {
  const controller = container.resolve<AdminMapSettingsController>('adminMapSettingsController');

  const canRead = { preHandler: fastify.authorize({ permissions: ['settings:read'] }) };
  const canWrite = { preHandler: fastify.authorize({ permissions: ['settings:write'] }) };

  fastify.get('/settings/maps', canRead, (req, reply) => controller.getMapSettings(req, reply));
  fastify.put('/settings/maps', canWrite, (req, reply) => controller.updateMapSettings(req, reply));
  fastify.post('/settings/maps/test', canWrite, (req, reply) =>
    controller.testProvider(req, reply),
  );
}

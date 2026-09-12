import type { FastifyInstance } from 'fastify';
import { container } from '@core/di';
import { AppConfigAdminController } from '../controllers/app-config-admin.controller.js';

export async function appConfigAdminRoutes(fastify: FastifyInstance): Promise<void> {
  const controller = container.resolve<AppConfigAdminController>('appConfigAdminController');

  const canRead = { preHandler: fastify.authorize({ permissions: ['settings:read'] }) };
  const canWrite = { preHandler: fastify.authorize({ permissions: ['settings:write'] }) };

  fastify.get('/themes', canRead, (req, reply) => controller.listThemes(req, reply));
  fastify.put('/themes', canWrite, (req, reply) => controller.updateTheme(req, reply));

  fastify.get('/fonts', canRead, (req, reply) => controller.listFonts(req, reply));
  fastify.put('/fonts', canWrite, (req, reply) => controller.updateFonts(req, reply));

  fastify.get('/locales', canRead, (req, reply) => controller.listLocales(req, reply));
  fastify.post('/locales', canWrite, (req, reply) => controller.createLocale(req, reply));
  fastify.put('/locales', canWrite, (req, reply) => controller.updateLocale(req, reply));

  fastify.get('/translations', canRead, (req, reply) => controller.listTranslations(req, reply));
  fastify.put('/translations', canWrite, (req, reply) => controller.upsertTranslations(req, reply));

  fastify.post('/publish', canWrite, (req, reply) => controller.publish(req, reply));
  fastify.post('/reset', canWrite, (req, reply) => controller.resetTheme(req, reply));
}

import type { FastifyInstance } from 'fastify';
import { container } from '@core/di';
import { rateLimits } from '@config';
import { MapsController } from '../controllers/maps.controller.js';

export async function mapsRoutes(fastify: FastifyInstance): Promise<void> {
  const controller = container.resolve<MapsController>('mapsController');

  fastify.addHook('preHandler', fastify.authenticate);

  fastify.get('/config', (req, reply) => controller.getConfig(req, reply));

  fastify.get(
    '/places/autocomplete',
    { preHandler: fastify.rateLimit(rateLimits.mapsSearch) },
    (req, reply) => controller.autocomplete(req, reply),
  );

  fastify.get('/places/:provider/:placeId', (req, reply) => controller.placeDetails(req, reply));

  fastify.post('/geocode', { preHandler: fastify.rateLimit(rateLimits.mapsSearch) }, (req, reply) =>
    controller.geocode(req, reply),
  );

  fastify.post(
    '/reverse-geocode',
    { preHandler: fastify.rateLimit(rateLimits.mapsSearch) },
    (req, reply) => controller.reverseGeocode(req, reply),
  );

  fastify.post('/routes', { preHandler: fastify.rateLimit(rateLimits.mapsRoute) }, (req, reply) =>
    controller.route(req, reply),
  );

  fastify.post(
    '/route-matrix',
    {
      preHandler: [
        fastify.authorize({ permissions: ['settings:read'] }),
        fastify.rateLimit(rateLimits.mapsRoute),
      ],
    },
    (req, reply) => controller.routeMatrix(req, reply),
  );
}

import type { FastifyInstance } from 'fastify';
import { container } from '@core/di';
import { rateLimits } from '@config';
import { RideController } from '../controllers/ride.controller.js';
import { handleRideError } from '../schemas/error-response.js';

/// Every `:id` on this router is a UUID that ends up in a `::uuid` cast or a
/// Prisma `@db.Uuid` lookup. Without this, `POST /rides/offers/not-a-uuid/reject`
/// reached Postgres, which raised `invalid input syntax for type uuid`, which
/// surfaced as **500 INTERNAL** — a client mistake reported as a server fault,
/// and a needless round trip to the database for input that could never match.
///
/// A `pattern` rather than `format: 'uuid'` on purpose: core ajv validates
/// patterns out of the box, whereas `format` silently does nothing unless
/// `ajv-formats` is registered, and nothing registers it here.
const uuidParams = {
  type: 'object',
  required: ['id'],
  properties: {
    id: {
      type: 'string',
      pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
    },
  },
} as const;

const byId = { schema: { params: uuidParams } };

export async function rideRoutes(fastify: FastifyInstance): Promise<void> {
  const controller = container.resolve<RideController>('rideController');
  fastify.setErrorHandler(handleRideError);
  fastify.post('/quote', (req, reply) => controller.request.quote(req, reply));
  fastify.post('/requests', { preHandler: fastify.rateLimit(rateLimits.rideWrite) }, (req, reply) =>
    controller.request.createRequest(req, reply),
  );
  fastify.post(
    '/requests/:id/cancel',
    { ...byId, preHandler: fastify.rateLimit(rateLimits.rideWrite) },
    (req, reply) => controller.request.cancelRequest(req, reply),
  );
  const driverOnly = { preHandler: fastify.authorize({ requireOperableDriver: true }) };
  const driverOnlyById = { ...byId, ...driverOnly };
  fastify.get('/offers', driverOnly, (req, reply) => controller.state.listOffers(req, reply));
  fastify.post('/offers/:id/reject', driverOnlyById, (req, reply) =>
    controller.state.rejectOffer(req, reply),
  );
  fastify.post('/accept', driverOnly, (req, reply) => controller.state.accept(req, reply));
  fastify.post('/:id/arriving', driverOnlyById, (req, reply) =>
    controller.state.arriving(req, reply),
  );
  fastify.post('/:id/arrive', driverOnlyById, (req, reply) => controller.state.arrive(req, reply));
  fastify.post('/:id/start', driverOnlyById, (req, reply) => controller.state.start(req, reply));
  fastify.post('/:id/complete', driverOnlyById, (req, reply) =>
    controller.state.complete(req, reply),
  );
  fastify.post(
    '/:id/cancel',
    { ...byId, preHandler: fastify.rateLimit(rateLimits.rideWrite) },
    (req, reply) => controller.state.cancel(req, reply),
  );

  fastify.get('/active', (req, reply) => controller.query.getActive(req, reply));
  fastify.get('/history', (req, reply) => controller.query.listHistory(req, reply));
  fastify.get('/:id', byId, (req, reply) => controller.query.getById(req, reply));
  fastify.get('/:id/receipt', byId, (req, reply) => controller.query.getReceipt(req, reply));
  fastify.get('/:id/driver-location', byId, (req, reply) =>
    controller.query.getDriverLocation(req, reply),
  );
}

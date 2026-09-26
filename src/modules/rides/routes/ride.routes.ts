import type { FastifyInstance } from 'fastify';
import { container } from '@core/di';
import { rateLimits } from '@config';
import { RideController } from '../controllers/ride.controller.js';
import { handleRideError } from '../schemas/error-response.js';

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
  fastify.patch(
    '/requests/:id/boost',
    { ...byId, preHandler: fastify.rateLimit(rateLimits.rideWrite) },
    (req, reply) => controller.request.boostRequest(req, reply),
  );
  fastify.get('/requests/active', (req, reply) => controller.request.getActiveRequest(req, reply));
  fastify.get('/requests/:id', byId, (req, reply) => controller.request.getRequestById(req, reply));

  const driverOnly = { preHandler: fastify.authorize({ requireOperableDriver: true }) };
  const driverOnlyById = { ...byId, ...driverOnly };
  fastify.get('/offers', driverOnly, (req, reply) => controller.state.listOffers(req, reply));
  fastify.post('/offers/:id/reject', driverOnlyById, (req, reply) =>
    controller.state.rejectOffer(req, reply),
  );
  fastify.post('/accept', driverOnly, (req, reply) => controller.state.accept(req, reply));

  fastify.get('/my-scheduled', (req, reply) => controller.scheduled.listMine(req, reply));
  fastify.post('/scheduled/:id/cancel', byId, (req, reply) =>
    controller.scheduled.cancelMine(req, reply),
  );
  fastify.post('/scheduled/:id/accept', driverOnlyById, (req, reply) =>
    controller.scheduled.accept(req, reply),
  );
  fastify.post('/scheduled/:id/decline', driverOnlyById, (req, reply) =>
    controller.scheduled.decline(req, reply),
  );

  fastify.get('/share/:token', { config: { public: true } }, (req, reply) =>
    controller.safety.viewShared(req, reply),
  );

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

  fastify.post(
    '/:id/destination/quote',
    { ...byId, preHandler: fastify.rateLimit(rateLimits.rideWrite) },
    (req, reply) => controller.request.quoteDestination(req, reply),
  );
  fastify.post(
    '/:id/destination',
    { ...byId, preHandler: fastify.rateLimit(rateLimits.rideWrite) },
    (req, reply) => controller.request.confirmDestination(req, reply),
  );
  fastify.post(
    '/:id/sos',
    { ...byId, preHandler: fastify.rateLimit(rateLimits.rideWrite) },
    (req, reply) => controller.safety.sos(req, reply),
  );
  fastify.post(
    '/:id/share',
    { ...byId, preHandler: fastify.rateLimit(rateLimits.rideWrite) },
    (req, reply) => controller.safety.share(req, reply),
  );

  fastify.get('/active', (req, reply) => controller.query.getActive(req, reply));
  fastify.get('/history', (req, reply) => controller.query.listHistory(req, reply));

  fastify.get('/:id/messages', byId, (req, reply) => controller.chat.list(req, reply));
  fastify.post('/:id/messages', byId, (req, reply) => controller.chat.send(req, reply));
  fastify.post('/:id/call', byId, (req, reply) => controller.call.initiate(req, reply));

  fastify.get('/:id', byId, (req, reply) => controller.query.getById(req, reply));
  fastify.get('/:id/receipt', byId, (req, reply) => controller.query.getReceipt(req, reply));
  fastify.get('/:id/driver-location', byId, (req, reply) =>
    controller.query.getDriverLocation(req, reply),
  );
}

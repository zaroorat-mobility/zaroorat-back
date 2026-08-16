import type { FastifyInstance } from 'fastify';
import { container } from '@core/di';
import { rateLimits } from '@config';
import { RideController } from '../controllers/ride.controller.js';
import { handleRideError } from '../schemas/error-response.js';
export async function rideRoutes(fastify: FastifyInstance): Promise<void> {
  const controller = container.resolve<RideController>('rideController');
  fastify.setErrorHandler(handleRideError);
  fastify.post('/quote', (req, reply) => controller.request.quote(req, reply));
  fastify.post('/requests', { preHandler: fastify.rateLimit(rateLimits.rideWrite) }, (req, reply) =>
    controller.request.createRequest(req, reply),
  );
  const driverOnly = { preHandler: fastify.authorize({ requireOperableDriver: true }) };
  fastify.post('/accept', driverOnly, (req, reply) => controller.state.accept(req, reply));
  fastify.post('/:id/arrive', driverOnly, (req, reply) => controller.state.arrive(req, reply));
  fastify.post('/:id/start', driverOnly, (req, reply) => controller.state.start(req, reply));
  fastify.post('/:id/complete', driverOnly, (req, reply) => controller.state.complete(req, reply));
  fastify.post(
    '/:id/cancel',
    { preHandler: fastify.rateLimit(rateLimits.rideWrite) },
    (req, reply) => controller.state.cancel(req, reply),
  );
  fastify.get('/active', (req, reply) => controller.query.getActive(req, reply));
  fastify.get('/history', (req, reply) => controller.query.listHistory(req, reply));
  fastify.get('/:id', (req, reply) => controller.query.getById(req, reply));
  fastify.get('/:id/receipt', (req, reply) => controller.query.getReceipt(req, reply));
}

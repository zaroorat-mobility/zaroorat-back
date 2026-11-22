import type { FastifyInstance } from 'fastify';
import { container } from '@core/di';
import { cashConfirmationRequired, rateLimits } from '@config';
import { RidePaymentController } from '../controllers/ride-payment.controller.js';
import { handlePaymentError } from '../schemas/error-response.js';

const rideIdParams = {
  type: 'object',
  required: ['rideId'],
  properties: {
    rideId: {
      type: 'string',
      pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
    },
  },
} as const;

const byRideId = { schema: { params: rideIdParams } };

/// Mounted at `/api/v1/rides`, the way `ratingRoutes` is — these are ride-
/// scoped paths that happen to be owned by the payments module, so the URL
/// follows the resource rather than the code layout.
export async function ridePaymentRoutes(fastify: FastifyInstance): Promise<void> {
  const controller = container.resolve<RidePaymentController>('ridePaymentController');
  // Scoped to this plugin — an error handler registered elsewhere does not
  // reach here, and without this the coded payment errors lose their status.
  fastify.setErrorHandler(handlePaymentError);

  fastify.get('/:rideId/payment', byRideId, (req, reply) => controller.getRidePayment(req, reply));
  fastify.post(
    '/:rideId/payment/retry',
    { ...byRideId, preHandler: fastify.rateLimit(rateLimits.payment) },
    (req, reply) => controller.retry(req, reply),
  );

  // BD-5 requires that no client can access *or execute* the flow while it is
  // disabled. A registered route returning 403 would still be accessible, so
  // the route simply does not exist and Fastify answers 404.
  if (cashConfirmationRequired()) {
    fastify.post(
      '/:rideId/payment/confirm-cash',
      {
        ...byRideId,
        // Confirming is a driver action, but it must never gate the driver's
        // next ride — BD-3.
        preHandler: [fastify.authorize({ requireOperableDriver: true })],
      },
      (req, reply) => controller.confirmCash(req, reply),
    );
  }
}

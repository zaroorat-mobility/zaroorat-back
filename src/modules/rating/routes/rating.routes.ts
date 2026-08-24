import type { FastifyInstance } from 'fastify';
import { container } from '@core/di';
import { rateLimits } from '@config';
import { RatingController } from '../controllers/rating.controller.js';
import { handleRideError } from '../../rides/schemas/error-response.js';

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

export async function ratingRoutes(fastify: FastifyInstance): Promise<void> {
  const controller = container.resolve<RatingController>('ratingController');

  // We reuse the ride error handler because we throw ride-related errors (RideNotFoundError, etc.)
  fastify.setErrorHandler(handleRideError);

  // Mounted via /api/v1/rides (so path is POST /:id/rating)
  fastify.post(
    '/:id/rating',
    { ...byId, preHandler: fastify.rateLimit(rateLimits.rideWrite) },
    (req, reply) => controller.submitRating(req, reply),
  );
}

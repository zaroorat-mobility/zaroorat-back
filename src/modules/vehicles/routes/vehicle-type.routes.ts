import type { FastifyInstance } from 'fastify';
import { container } from '@core/di';
import { VehicleTypeController } from '../controllers/vehicle-type.controller.js';
import { handleVehicleError } from '../schemas/error-response.js';
import {
  listVehicleTypesQuerySchema,
  vehicleErrorResponseSchema as err,
  vehicleTypeListResponse,
} from '../schemas/vehicle.responses.js';

export async function vehicleTypeRoutes(fastify: FastifyInstance): Promise<void> {
  const controller = container.resolve<VehicleTypeController>('vehicleTypeController');
  fastify.setErrorHandler(handleVehicleError);

  // Authenticated, not public: the catalog carries the platform's pricing, and
  // every caller that needs it (customer app, driver app) already holds a token
  // by the time it renders a picker. Left on the deny-by-default path.
  fastify.get(
    '/',
    {
      schema: {
        tags: ['Vehicles'],
        summary: 'List active vehicle types',
        description:
          'The category catalog. Returns active vehicle types in display order with their ' +
          'pricing, and is the only sanctioned source of the `vehicleTypeId` required by ' +
          'POST /rides/quote, POST /rides/requests and POST /vehicles/me/claim.',
        security: [{ bearerAuth: [] }],
        querystring: listVehicleTypesQuerySchema,
        response: { 200: vehicleTypeListResponse, 401: err, 500: err },
      },
    },
    (req, reply) => controller.list(req, reply),
  );
}

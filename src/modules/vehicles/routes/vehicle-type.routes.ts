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

  // Public catalog: allows HomeScreen and ServicesScreen to browse available vehicle
  // categories dynamically without requiring an upfront bearer token.
  fastify.get(
    '/',
    {
      config: { public: true },
      schema: {
        tags: ['Vehicles'],
        summary: 'List active vehicle types',
        description:
          'The category catalog. Returns active vehicle types in display order with their ' +
          'pricing, and is the only sanctioned source of the `vehicleTypeId` required by ' +
          'POST /rides/quote, POST /rides/requests and POST /vehicles/me/claim.',
        querystring: listVehicleTypesQuerySchema,
        response: { 200: vehicleTypeListResponse, 500: err },
      },
    },
    (req, reply) => controller.list(req, reply),
  );

  // Public permanent vehicle image asset proxy:
  // Allows the mobile app to load and cache vehicle icons at 60fps with zero authentication overhead.
  fastify.get(
    '/images/:fileId',
    {
      config: { public: true },
      schema: {
        tags: ['Vehicles'],
        summary: 'Get public vehicle icon asset',
        description:
          'Permanent public redirect to vehicle icon in cloud storage with 7-day client cache headers.',
        params: {
          type: 'object',
          required: ['fileId'],
          properties: {
            fileId: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    (req, reply) => controller.serveVehicleImage(req, reply),
  );
}

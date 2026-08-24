import type { FastifyInstance } from 'fastify';
import { container } from '@core/di';
import { AdminVehicleManagementController } from './vehicle-management.controller.js';
import { handleVehicleError } from '@modules/vehicles/schemas/error-response.js';
import {
  vehicleDocumentParamSchema,
  vehicleIdParamSchema,
  vehicleDocumentResponse,
  vehicleReviewResponse,
  vehicleResponse,
  vehicleErrorResponseSchema as err,
} from '@modules/vehicles/schemas/vehicle.responses.js';
import { reviewVehicleBodySchema } from '@modules/vehicles/schemas/vehicle.responses.js';

const commonErrors = { 400: err, 401: err, 403: err, 500: err } as const;
const itemErrors = { ...commonErrors, 404: err } as const;

export async function adminVehicleRoutes(fastify: FastifyInstance): Promise<void> {
  // Error handlers are scoped to the Fastify plugin that registers them. These
  // routes moved here from their domain module and left its handler behind, so
  // coded domain errors were falling through to the global handler and losing
  // their code/status/details. Restored per constitution S13.3.
  fastify.setErrorHandler(handleVehicleError);

  const controller = container.resolve<AdminVehicleManagementController>(
    'adminVehicleManagementController',
  );

  fastify.get(
    '/vehicles/:id/review',
    {
      preHandler: fastify.authorize({ roles: ['admin'] }),
      schema: {
        tags: ['Admin', 'Vehicles'],
        summary: 'Get a vehicle with its documents for review',
        security: [{ bearerAuth: [] }],
        params: vehicleIdParamSchema,
        response: { 200: vehicleReviewResponse, ...itemErrors },
      },
    },
    (req, reply) => controller.getForReview(req, reply),
  );

  fastify.post(
    '/vehicles/:id/documents/:documentId/review',
    {
      preHandler: fastify.authorize({ roles: ['admin'] }),
      schema: {
        tags: ['Admin', 'Vehicles'],
        summary: 'Approve or reject a vehicle document',
        security: [{ bearerAuth: [] }],
        params: vehicleDocumentParamSchema,
        body: reviewVehicleBodySchema,
        response: { 200: vehicleDocumentResponse, ...itemErrors, 409: err },
      },
    },
    (req, reply) => controller.reviewDocument(req, reply),
  );

  fastify.post(
    '/vehicles/:id/verify',
    {
      preHandler: fastify.authorize({ roles: ['admin'] }),
      schema: {
        tags: ['Admin', 'Vehicles'],
        summary: 'Approve or reject a vehicle',
        security: [{ bearerAuth: [] }],
        params: vehicleIdParamSchema,
        body: reviewVehicleBodySchema,
        response: { 200: vehicleResponse, ...itemErrors, 409: err, 422: err },
      },
    },
    (req, reply) => controller.reviewVehicle(req, reply),
  );
}

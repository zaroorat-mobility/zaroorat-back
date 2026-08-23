import type { FastifyInstance } from 'fastify';
import { container } from '@core/di';
import { VehicleController } from '../controllers/vehicle.controller.js';
import { VehicleDocumentController } from '../controllers/vehicle-document.controller.js';
import { handleVehicleError } from '../schemas/error-response.js';
import {
  claimVehicleBodySchema,
  myVehicleResponse,
  noContentResponse,
  submitVehicleDocumentBodySchema,
  updateVehicleBodySchema,
  vehicleDocumentListResponse,
  vehicleDocumentResponse,
  vehicleErrorResponseSchema as err,
  vehicleIdParamSchema,
  vehicleResponse,
} from '../schemas/vehicle.responses.js';

const commonErrors = { 400: err, 401: err, 403: err, 500: err } as const;
const itemErrors = { ...commonErrors, 404: err } as const;

export async function vehicleRoutes(fastify: FastifyInstance): Promise<void> {
  const controller = container.resolve<VehicleController>('vehicleController');
  const documents = container.resolve<VehicleDocumentController>('vehicleDocumentController');
  fastify.setErrorHandler(handleVehicleError);

  // Not gated on requireOperableDriver: registering a vehicle is part of
  // onboarding setup (like document submission), not a go-online action —
  // a driver awaiting verification still needs to be able to claim their
  // vehicle. The controller itself requires a Driver row to exist.
  fastify.post(
    '/me/claim',
    {
      schema: {
        tags: ['Vehicles'],
        summary: 'Claim or register a vehicle',
        description:
          'Registers the vehicle the driver is currently operating and assigns it to them, ' +
          'releasing any previous assignment. The vehicle type must be active. Re-claiming an ' +
          'existing plate under a different category resets that vehicle to PENDING review.',
        security: [{ bearerAuth: [] }],
        body: claimVehicleBodySchema,
        response: { 200: vehicleResponse, ...itemErrors, 409: err },
      },
    },
    (req, reply) => controller.claim(req, reply),
  );

  fastify.get(
    '/me',
    {
      schema: {
        tags: ['Vehicles'],
        summary: "Get the caller's assigned vehicle",
        description:
          'Returns the vehicle currently assigned to the acting driver with its type and ' +
          'documents, or null when no vehicle has been claimed yet.',
        security: [{ bearerAuth: [] }],
        response: { 200: myVehicleResponse, ...itemErrors },
      },
    },
    (req, reply) => controller.getMine(req, reply),
  );

  fastify.post(
    '/me/release',
    {
      schema: {
        tags: ['Vehicles'],
        summary: 'Release the assigned vehicle',
        description:
          'Ends the assignment so another driver can claim the same vehicle. Refused with 409 ' +
          'VEHICLE_IN_USE while the driver is on an active trip. The vehicle row itself is kept.',
        security: [{ bearerAuth: [] }],
        response: { 204: noContentResponse, ...itemErrors, 409: err },
      },
    },
    (req, reply) => controller.release(req, reply),
  );

  fastify.patch(
    '/:id',
    {
      schema: {
        tags: ['Vehicles'],
        summary: 'Update owned vehicle details',
        description:
          'Editable descriptive fields only. Registration number and vehicle type are not ' +
          'editable — both are what an operator reviewed and what ride acceptance matches ' +
          'against, so changing either goes through /vehicles/me/claim. Editing a VERIFIED ' +
          'vehicle returns it to PENDING review.',
        security: [{ bearerAuth: [] }],
        params: vehicleIdParamSchema,
        body: updateVehicleBodySchema,
        response: { 200: vehicleResponse, ...itemErrors },
      },
    },
    (req, reply) => controller.update(req, reply),
  );

  fastify.post(
    '/:id/documents',
    {
      schema: {
        tags: ['Vehicles'],
        summary: 'Submit a vehicle document',
        description:
          'Links an already-uploaded file to the vehicle. The file must be READY, owned by the ' +
          'caller and have purpose VEHICLE_DOCUMENT — verified through the Files module, not ' +
          'here. Re-submitting a type replaces the previous file and hands it to retention.',
        security: [{ bearerAuth: [] }],
        params: vehicleIdParamSchema,
        body: submitVehicleDocumentBodySchema,
        response: { 201: vehicleDocumentResponse, ...itemErrors, 409: err, 422: err },
      },
    },
    (req, reply) => documents.submit(req, reply),
  );

  fastify.get(
    '/:id/documents',
    {
      schema: {
        tags: ['Vehicles'],
        summary: 'List vehicle documents',
        description: 'The assigned driver, or an admin/support operator.',
        security: [{ bearerAuth: [] }],
        params: vehicleIdParamSchema,
        response: { 200: vehicleDocumentListResponse, ...itemErrors },
      },
    },
    (req, reply) => documents.list(req, reply),
  );
}

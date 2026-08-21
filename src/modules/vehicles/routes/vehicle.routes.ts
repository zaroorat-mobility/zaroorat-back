import type { FastifyInstance } from 'fastify';
import { container } from '@core/di';
import { VehicleController } from '../controllers/vehicle.controller.js';
import { handleVehicleError } from '../schemas/error-response.js';
export async function vehicleRoutes(fastify: FastifyInstance): Promise<void> {
  const controller = container.resolve<VehicleController>('vehicleController');
  fastify.setErrorHandler(handleVehicleError);
  // Not gated on requireOperableDriver: registering a vehicle is part of
  // onboarding setup (like document submission), not a go-online action —
  // a driver awaiting verification still needs to be able to claim their
  // vehicle. The controller itself requires a Driver row to exist.
  fastify.post('/me/claim', (req, reply) => controller.claim(req, reply));
}

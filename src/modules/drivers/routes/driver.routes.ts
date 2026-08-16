import type { FastifyInstance } from 'fastify';
import { container } from '@core/di';
import { rateLimits } from '@config';
import { DriverController } from '../controllers/driver.controller.js';
import { handleDriverError } from '../schemas/error-response.js';
export async function driverRoutes(fastify: FastifyInstance): Promise<void> {
  const controller = container.resolve<DriverController>('driverController');
  fastify.setErrorHandler(handleDriverError);
  fastify.get('/me', (req, reply) => controller.onboarding.getMe(req, reply));
  fastify.patch('/:driverId/profile', (req, reply) =>
    controller.onboarding.updateProfile(req, reply),
  );
  fastify.post('/:driverId/documents', (req, reply) =>
    controller.onboarding.submitDocument(req, reply),
  );
  fastify.post(
    '/:id/verify',
    { preHandler: fastify.authorize({ roles: ['admin'] }) },
    (req, reply) => controller.onboarding.reviewVerification(req, reply),
  );
  fastify.post(
    '/status/online',
    { preHandler: fastify.authorize({ requireOperableDriver: true }) },
    (req, reply) => controller.status.setOnline(req, reply),
  );
  fastify.post('/status/offline', (req, reply) => controller.status.setOffline(req, reply));
  fastify.post('/heartbeat', (req, reply) => controller.status.heartbeat(req, reply));
  fastify.post(
    '/:id/suspend',
    { preHandler: fastify.authorize({ roles: ['admin'] }) },
    (req, reply) => controller.status.suspend(req, reply),
  );
  fastify.post(
    '/location',
    { preHandler: fastify.rateLimit(rateLimits.driverLocation) },
    (req, reply) => controller.location.updateLocation(req, reply),
  );
  fastify.get('/:id/location', (req, reply) => controller.location.getLocation(req, reply));
  fastify.get('/:driverId/wallet', (req, reply) => controller.wallet.getWallet(req, reply));
  fastify.get('/:driverId/wallet/transactions', (req, reply) =>
    controller.wallet.listTransactions(req, reply),
  );
}

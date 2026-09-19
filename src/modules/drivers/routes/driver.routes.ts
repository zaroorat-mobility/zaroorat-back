import type { FastifyInstance } from 'fastify';
import { container } from '@core/di';
import { rateLimits } from '@config';
import { DriverController } from '../controllers/driver.controller.js';
import { handleDriverError } from '../schemas/error-response.js';

export async function driverRoutes(fastify: FastifyInstance): Promise<void> {
  const controller = container.resolve<DriverController>('driverController');
  fastify.setErrorHandler(handleDriverError);

  // Static `/me/*` routes MUST be registered before `/:driverId` params so
  // Fastify does not capture `me` as a driver id.
  fastify.get('/me', (req, reply) => controller.onboarding.getMe(req, reply));
  fastify.post('/me/onboard', (req, reply) => controller.onboarding.onboard(req, reply));

  fastify.get('/me/earnings/summary', (req, reply) => controller.earnings.summary(req, reply));
  fastify.get('/me/earnings/daily', (req, reply) => controller.earnings.daily(req, reply));
  fastify.get('/me/rides', (req, reply) => controller.earnings.rides(req, reply));
  fastify.get('/me/scheduled-rides', (req, reply) => controller.scheduled.list(req, reply));
  fastify.get('/me/withdrawals', (req, reply) => controller.withdrawals.list(req, reply));
  fastify.post('/me/withdrawals', (req, reply) => controller.withdrawals.create(req, reply));

  fastify.patch('/:driverId/profile', (req, reply) =>
    controller.onboarding.updateProfile(req, reply),
  );
  fastify.post('/:driverId/documents', (req, reply) =>
    controller.documents.submitDocument(req, reply),
  );

  fastify.post(
    '/status/online',
    { preHandler: fastify.authorize({ requireOperableDriver: true }) },
    (req, reply) => controller.status.setOnline(req, reply),
  );
  fastify.post('/status/offline', (req, reply) => controller.status.setOffline(req, reply));
  fastify.post('/heartbeat', (req, reply) => controller.status.heartbeat(req, reply));

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

  fastify.post('/payment-model', (req, reply) => controller.paymentModel.select(req, reply));
  fastify.get('/payment-model', (req, reply) => controller.paymentModel.getStatus(req, reply));

  fastify.get('/:driverId/commission-wallet', (req, reply) =>
    controller.commissionWallet.getWallet(req, reply),
  );
  fastify.get('/:driverId/commission-wallet/transactions', (req, reply) =>
    controller.commissionWallet.listTransactions(req, reply),
  );
}

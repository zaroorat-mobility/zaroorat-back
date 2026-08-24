import type { FastifyInstance } from 'fastify';
import { container } from '@core/di';
import { rateLimits } from '@config';
import { registerRawJsonParser } from '../../../plugins/raw-body/raw-body.plugin.js';
import { PaymentController } from '../controllers/payment.controller.js';
import { handlePaymentError } from '../schemas/error-response.js';
export async function paymentRoutes(fastify: FastifyInstance): Promise<void> {
  const controller = container.resolve<PaymentController>('paymentController');
  fastify.setErrorHandler(handlePaymentError);
  fastify.get('/methods', (req, reply) => controller.paymentMethod.listUserMethods(req, reply));
  fastify.get('/me/debt', (req, reply) => controller.ridePayment.getMyDebt(req, reply));
  fastify.get('/wallet/balance', (req, reply) => controller.wallet.getBalance(req, reply));
  fastify.post(
    '/wallet/topup',
    { preHandler: fastify.rateLimit(rateLimits.payment) },
    (req, reply) => controller.wallet.topup(req, reply),
  );
  fastify.post(
    '/wallet/hold',
    { preHandler: fastify.rateLimit(rateLimits.payment) },
    (req, reply) => controller.wallet.hold(req, reply),
  );
  fastify.post('/intents', { preHandler: fastify.rateLimit(rateLimits.payment) }, (req, reply) =>
    controller.intent.createIntent(req, reply),
  );
  fastify.post(
    '/intents/:intentId/confirm',
    { preHandler: fastify.rateLimit(rateLimits.payment) },
    (req, reply) => controller.intent.confirmIntent(req, reply),
  );
  fastify.post('/refunds', { preHandler: fastify.rateLimit(rateLimits.payment) }, (req, reply) =>
    controller.refund.processRefund(req, reply),
  );

  await fastify.register(async (webhookScope) => {
    registerRawJsonParser(webhookScope);
    webhookScope.post(
      '/webhooks/:gateway',
      {
        config: { public: true },
        preHandler: webhookScope.rateLimit(rateLimits.webhook),
      },
      (req, reply) => controller.webhook.handleWebhook(req, reply),
    );
  });
}

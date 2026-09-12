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
  // 004-driver-subscription-wallet. spec.md FR-008/FR-008a/FR-008b.
  fastify.get('/driver-wallet/recharge-options', (req, reply) =>
    controller.commissionWallet.listRechargeOptions(req, reply),
  );
  fastify.post(
    '/driver-wallet/recharge',
    { preHandler: fastify.rateLimit(rateLimits.payment) },
    (req, reply) => controller.commissionWallet.recharge(req, reply),
  );

  await fastify.register(async (webhookScope) => {
    registerRawJsonParser(webhookScope);
    const webhookRoute = {
      config: { public: true },
      preHandler: webhookScope.rateLimit(rateLimits.webhook),
    };
    webhookScope.post('/webhooks/razorpay', webhookRoute, (req, reply) =>
      controller.webhook.handleRazorpayWebhook(req, reply),
    );
    webhookScope.post('/webhooks/stripe', webhookRoute, (req, reply) =>
      controller.webhook.handleStripeWebhook(req, reply),
    );
  });
}

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
  // No `POST /wallet/topup` and no generic `POST /intents`: a gateway payment
  // may only fund a driver subscription or a commission recharge
  // (`GATEWAY_PAYMENT_PURPOSES`), each created by its own route below / in
  // the subscriptions module. A customer's ride fare is paid to the driver.
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

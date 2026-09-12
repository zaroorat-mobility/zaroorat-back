import type { FastifyReply, FastifyRequest } from 'fastify';
import { PaymentService } from '../services/payment.service.js';
import { WebhookSignatureError } from '../errors/payment.errors.js';
import type { GatewayWebhookPayload } from '../services/webhook/webhook.service.js';

function headerString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/// One handler per provider — each route knows exactly which header(s) its
/// own provider's signature scheme needs, rather than guessing from a list
/// of every provider's header name the way the old single `:gateway` route
/// did. `req.rawBody` is the exact bytes the provider signed; parsing
/// `req.body` first and re-serializing it would not reproduce that byte
/// sequence and would fail every provider's signature check.
export class WebhookController {
  constructor(private readonly paymentService: PaymentService) {}

  private requireRawBody(req: FastifyRequest, gateway: string): string | Buffer {
    const rawBody = req.rawBody;
    if (!rawBody) {
      req.log.error(
        { gateway },
        '[payments] raw body unavailable — the raw-JSON parser is not installed on this route',
      );
      throw new WebhookSignatureError('Webhook signature cannot be verified');
    }
    return rawBody;
  }

  async handleRazorpayWebhook(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const signature = headerString(req.headers['x-razorpay-signature']);
    if (!signature) {
      req.log.warn('[payments] razorpay webhook rejected: no signature header');
      throw new WebhookSignatureError('Webhook signature header is missing');
    }
    const eventIdHeader = headerString(req.headers['x-razorpay-event-id']);
    const rawBody = this.requireRawBody(req, 'razorpay');
    const result = await this.paymentService.webhook.handleGatewayWebhook({
      gateway: 'razorpay',
      rawBody,
      signature,
      eventIdHeader,
      payload: req.body as GatewayWebhookPayload,
    });
    reply.status(200).send({ received: true, ...result });
  }

  async handleStripeWebhook(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const signature = headerString(req.headers['stripe-signature']);
    if (!signature) {
      req.log.warn('[payments] stripe webhook rejected: no signature header');
      throw new WebhookSignatureError('Webhook signature header is missing');
    }
    const rawBody = this.requireRawBody(req, 'stripe');
    const result = await this.paymentService.webhook.handleGatewayWebhook({
      gateway: 'stripe',
      rawBody,
      signature,
      payload: req.body as GatewayWebhookPayload,
    });
    reply.status(200).send({ received: true, ...result });
  }
}

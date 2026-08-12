import type { FastifyReply, FastifyRequest } from 'fastify';
import { PaymentService } from '../services/payment.service.js';
import { WebhookSignatureError } from '../errors/payment.errors.js';
import type { GatewayWebhookPayload } from '../services/webhook/webhook.service.js';

const SIGNATURE_HEADERS = [
  'x-razorpay-signature',
  'stripe-signature',
  'x-webhook-signature',
] as const;

export class WebhookController {
  constructor(private readonly paymentService: PaymentService) {}

  async handleWebhook(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { gateway } = req.params as { gateway: string };

    const signature = SIGNATURE_HEADERS.map((header) => req.headers[header]).find(
      (value): value is string => typeof value === 'string' && value.length > 0,
    );

    if (!signature) {
      req.log.warn({ gateway }, '[payments] webhook rejected: no signature header');
      throw new WebhookSignatureError('Webhook signature header is missing');
    }

    const rawBody = req.rawBody;
    if (!rawBody) {
      req.log.error(
        { gateway },
        '[payments] raw body unavailable — the raw-JSON parser is not installed on this route',
      );
      throw new WebhookSignatureError('Webhook signature cannot be verified');
    }

    const result = await this.paymentService.webhook.handleGatewayWebhook(
      gateway,
      rawBody,
      signature,
      req.body as GatewayWebhookPayload,
    );

    reply.status(200).send({ received: true, ...result });
  }
}

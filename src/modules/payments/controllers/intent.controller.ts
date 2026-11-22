import type { FastifyReply, FastifyRequest } from 'fastify';
import { assertOwnerOrStaff, callerId, ForbiddenResourceError } from '@core/auth';
import { PaymentNotFoundError } from '../errors/payment.errors.js';
import { PaymentService } from '../services/payment.service.js';
import type { CheckoutCallback } from '../services/intent/intent.service.js';
import type { PaymentIntent } from '../types';
import type { IntentView } from '../schemas/payment.responses.js';
export class IntentController {
  constructor(private readonly paymentService: PaymentService) {}
  async confirmIntent(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { intentId } = req.params as {
      intentId: string;
    };
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
    await this.visibleIntent(req, intentId, { allowStaff: true });
    // The one mutating payment route that was not idempotent (FR-040). It
    // matters more now than it did before: confirmation is what moves the
    // balance, so a retried confirm is a retried credit.
    const result = await this.paymentService.withIdempotency(
      callerId(req),
      '/payments/intents/confirm',
      idempotencyKey,
      { intentId },
      async () => {
        const intent = await this.paymentService.intent.confirmIntent(intentId, 'STAFF_CONFIRM');
        return {
          id: intent.id,
          userId: intent.userId,
          rideId: intent.rideId,
          amount: intent.amount.toNumber(),
          currency: intent.currency,
          status: intent.status,
          gateway: intent.gateway,
          gatewayIntentId: intent.gatewayIntentId,
          createdAt: intent.createdAt,
        } satisfies IntentView;
      },
    );
    reply.send({ data: result });
  }
  /// 005 T043 `GET /payments/intents/:intentId`: authoritative status from
  /// our database only, for the owner or staff.
  async getIntent(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { intentId } = req.params as { intentId: string };
    const intent = await this.visibleIntent(req, intentId, { allowStaff: true });
    reply.send({ data: await this.paymentService.intent.statusView(intent) });
  }
  /// 005 T043 `POST /payments/intents/:intentId/verify`: the owner submits the
  /// checkout success callback; the backend decides (TD-4, decision R1).
  async verifyIntent(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { intentId } = req.params as { intentId: string };
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
    const body = req.body as CheckoutCallback; // shape enforced by the route schema
    const intent = await this.visibleIntent(req, intentId, { allowStaff: false });
    const result = await this.paymentService.withIdempotency(
      callerId(req),
      '/payments/intents/verify',
      idempotencyKey,
      { intentId, ...body },
      async () => {
        const updated = await this.paymentService.intent.verifyCheckout(intent, body);
        return this.paymentService.intent.statusView(updated);
      },
    );
    reply.send({ data: result });
  }
  /// Someone else's intent answers exactly like a missing one, so these routes
  /// cannot be used to learn which intent ids exist (spec.md SEC-2, T027).
  private async visibleIntent(
    req: FastifyRequest,
    intentId: string,
    options: { allowStaff: boolean },
  ): Promise<PaymentIntent> {
    const existing = await this.paymentService.intent.findById(intentId);
    if (!existing) throw new PaymentNotFoundError(intentId);
    if (!options.allowStaff) {
      if (callerId(req) !== existing.userId) throw new PaymentNotFoundError(intentId);
      return existing;
    }
    try {
      assertOwnerOrStaff(req, existing.userId);
    } catch (err) {
      if (err instanceof ForbiddenResourceError) throw new PaymentNotFoundError(intentId);
      throw err;
    }
    return existing;
  }
}

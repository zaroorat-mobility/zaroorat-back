import type { FastifyReply, FastifyRequest } from 'fastify';
import { assertOwnerOrStaff, callerId } from '@core/auth';
import { PaymentNotFoundError } from '../errors/payment.errors.js';
import { Decimal } from '../types/index.js';
import { PaymentService } from '../services/payment.service.js';
import { createIntentSchema } from '../schemas/payment.schemas.js';
import type { IntentView } from '../schemas/payment.responses.js';
export class IntentController {
  constructor(private readonly paymentService: PaymentService) {}
  async createIntent(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const userId = callerId(req);
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
    const body = createIntentSchema.parse(req.body);
    const result = await this.paymentService.withIdempotency(
      userId,
      '/payments/intents',
      idempotencyKey,
      body,
      async () => {
        const intent = await this.paymentService.intent.createIntent({
          userId,
          amount: new Decimal(body.amount),
          methodType: body.methodType,
          idempotencyKey: idempotencyKey as string,
          ...(body.rideId !== undefined ? { rideId: body.rideId } : {}),
          ...(body.paymentMethodId !== undefined ? { paymentMethodId: body.paymentMethodId } : {}),
        });
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
  async confirmIntent(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { intentId } = req.params as {
      intentId: string;
    };
    const existing = await this.paymentService.intent.findById(intentId);
    if (!existing) throw new PaymentNotFoundError(intentId);
    assertOwnerOrStaff(req, existing.userId);
    const intent = await this.paymentService.intent.confirmIntent(intentId);
    const view: IntentView = {
      id: intent.id,
      userId: intent.userId,
      rideId: intent.rideId,
      amount: intent.amount.toNumber(),
      currency: intent.currency,
      status: intent.status,
      gateway: intent.gateway,
      gatewayIntentId: intent.gatewayIntentId,
      createdAt: intent.createdAt,
    };
    reply.send({ data: view });
  }
}

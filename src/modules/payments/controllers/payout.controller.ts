import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerId } from '@core/auth';
import { Decimal } from '../types/index.js';
import { PaymentService } from '../services/payment.service.js';
import { executePayoutSchema } from '../schemas/payment.schemas.js';

export class PayoutController {
  constructor(private readonly paymentService: PaymentService) {}

  async executePayout(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const userId = callerId(req);

    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
    const body = executePayoutSchema.parse(req.body);

    const result = await this.paymentService.withIdempotency(
      userId,
      '/payouts',
      idempotencyKey,
      body,
      async () => {
        const payout = await this.paymentService.payout.executePayout({
          driverId: body.driverId,
          amount: new Decimal(body.amount),
          idempotencyKey: idempotencyKey as string,
          ...(body.settlementId !== undefined ? { settlementId: body.settlementId } : {}),
          ...(body.bankAccountId !== undefined ? { bankAccountId: body.bankAccountId } : {}),
        });

        return {
          id: payout.id,
          driverId: payout.driverId,
          amount: payout.amount.toNumber(),
          status: payout.status,
        };
      },
    );

    reply.send({ data: result });
  }
}
